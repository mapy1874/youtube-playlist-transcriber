import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

// Enable playwright tracing only when env var ENABLE_TRACE=1
const ENABLE_TRACE = process.env.ENABLE_TRACE === '1';

// Serve static front-end files from public directory
app.use(express.static('public'));

/**
 * Fetch transcript of a YouTube video using Playwright.
 * Steps:
 * 1. Navigate to video URL.
 * 2. Click the "...more" button to expand description (if present).
 * 3. Click the "Show transcript" button.
 * 4. Read all text lines from transcript panel.
 */
async function fetchTranscript(videoUrl, onEvent=()=>{}) {
  const logs = [];
  function log(msg) { console.log(msg); logs.push(msg); onEvent('log', msg); }

  // Launch headless chromium
  const browser = await chromium.launch({ args: ['--disable-setuid-sandbox'], headless: true, channel: 'chromium' });
  const context = await browser.newContext({ locale: 'en-US' });
  let tracePath = undefined;
  if (ENABLE_TRACE) {
    const traceDir = 'traces';
    if (!fs.existsSync(traceDir)) fs.mkdirSync(traceDir, { recursive: true });
    tracePath = `${traceDir}/trace-${Date.now()}.zip`;
    await context.tracing.start({ screenshots: true, snapshots: true });
  }
  const page = await context.newPage();

  try {
    log(`Navigating to ${videoUrl}`);
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });

    // Give the page a moment and scroll once to bring description into view
    await page.waitForTimeout(1000);
    await page.keyboard.press('PageDown');

    // Wait for description more button and click if available
    log('Looking for "...more" expand button');

    // Target the exact element first: <tp-yt-paper-button id="expand">
    const expandButtons = page.locator('tp-yt-paper-button#expand');
    const expandCount = await expandButtons.count();
    log(`Found ${expandCount} #expand buttons`);
    if (expandCount > 0) {
      for (let i = 0; i < expandCount; i++) {
        const btn = expandButtons.nth(i);
        if (await btn.isVisible().catch(() => false)) {
          log(`Clicking #expand button index ${i}`);
          await btn.click();
          await page.waitForTimeout(300);
        }
      }
      await page.waitForTimeout(500);
    } else {
      // Previous generic logic
      const moreButtonLocator = page.getByRole('button', { name: /more/i });
      if (await moreButtonLocator.first().isVisible({ timeout: 8000 }).catch(() => false)) {
        log('Clicking "more"');
        await moreButtonLocator.first().click();
        await page.waitForTimeout(500);
      } else {
        log('"expand" / "more" button not found');
      }
    }

    // Gather all possible Show Transcript buttons and click the first that works
    let clickedTranscript = false;
    try {
      const transcriptButtons = page.locator('button:has-text("Show transcript"), button[aria-label="Show transcript"]');
      const total = await transcriptButtons.count();
      log(`Found ${total} candidate transcript buttons`);

      for (let i = 0; i < total; i++) {
        const btn = transcriptButtons.nth(i);
        log(`Attempting to click transcript button index ${i}`);
        try {
          await btn.click({ timeout: 300 });
          log(`Clicked transcript button index ${i}`);
          clickedTranscript = true;
          break; // stop on first success
        } catch (err) {
          log(`Button index ${i} failed to click: ${err.message}`);
        }
      }
    } catch (err) {
      log(`Error while locating transcript buttons: ${err.message}`);
    }

    if (!clickedTranscript) {
      log('Direct "Show transcript" buttons failed – trying kebab menu');
      const kebabMenu = page.getByRole('button', { name: /more actions/i });
      if (await kebabMenu.isVisible({ timeout: 8000 }).catch(() => false)) {
        await kebabMenu.click();
        const menuItem = page.getByRole('menuitem', { name: /show transcript/i });
        if (await menuItem.isVisible({ timeout: 8000 }).catch(() => false)) {
          log('Clicking menu item "Show transcript"');
          await menuItem.click();
          clickedTranscript = true;
        }
      }
    }

    if (!clickedTranscript) {
      throw new Error('Could not find "Show transcript" control');
    }

    // Wait for transcript panel to appear (handle duplicates)
    log('Waiting for transcript panel');
    await page.locator('ytd-transcript-renderer').first().waitFor({ timeout: 10000 });

    // Extract transcript lines (timestamp + text) from all renderers,
    // deduplicate by timestamp + text in case there are duplicates.
    log('Extracting transcript');
    const videoTitle = await page.title();
    const raw = await page.$$eval('ytd-transcript-renderer ytd-transcript-segment-renderer', segs =>
      segs.map(el => ({
        timestamp: el.querySelector('.segment-timestamp')?.innerText.trim(),
        text: el.querySelector('.segment-text')?.innerText.trim()
      }))
    );

    const seen = new Set();
    const items = raw.filter(seg => {
      if (!seg.timestamp || !seg.text) return false;
      const key = seg.timestamp + '|' + seg.text;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    log(`Extracted ${items.length} lines`);
    const result={ transcript: items, logs, tracePath, title: videoTitle };
    onEvent('video', result);
    return result;
  } catch (err) {
    log(`Error: ${err.message}`);
    throw err;
  } finally {
    // Stop tracing and save
    if (ENABLE_TRACE) {
      try {
        await context.tracing.stop({ path: tracePath });
        log(`Trace saved to ${tracePath}`);
      } catch (e) {
        console.error('Trace stop error', e);
      }
    }
    await browser.close();
  }
}

app.get('/api/transcript', async (req, res) => {
  const { videoUrl } = req.query;
  if (!videoUrl) {
    return res.status(400).json({ error: 'Missing videoUrl query parameter' });
  }

  try {
    const result = await fetchTranscript(videoUrl);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch transcript', details: err.message });
  }
});

// ---- PLAYLIST helper ----
async function fetchPlaylist(playlistUrl, onEvent = () => {}) {
  const logs = [];
  function log(m) { console.log(m); logs.push(m); onEvent('log', m); }
  log(`Fetching playlist ${playlistUrl}`);

  const browser = await chromium.launch({ args: ['--disable-setuid-sandbox'], headless: true, channel: 'chromium' });
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();

  const videos = [];
  try {
    await page.goto(playlistUrl, { waitUntil: 'domcontentloaded' });
    // wait for at least one video element
    await page.waitForSelector('ytd-playlist-video-renderer', { timeout: 15000 }).catch(() => {});
    const playlistTitle = await page.title();
    onEvent('meta', { title: playlistTitle });

    // Scroll to load up to 100 videos or end
    let lastCount = 0;
    for (let i = 0; i < 20; i++) {
      const count = await page.locator('ytd-playlist-video-renderer').count();
      if (count >= 100 || count === lastCount) break;
      lastCount = count;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1000);
    }

    const items = await page.$$eval('ytd-playlist-video-renderer a#video-title', (anchors) => {
      return anchors.slice(0, 100).map(a => ({
        title: a.textContent.trim(),
        url: new URL(a.href, location.origin).href
      }));
    });

    log(`Found ${items.length} videos in playlist`);

    // Fetch transcript for each video sequentially to avoid overload
    for (const [idx, vid] of items.entries()) {
      log(`Processing [${idx + 1}/${items.length}] ${vid.title}`);
      try {
        const { transcript } = await fetchTranscript(vid.url);
        const videoObj = { title: vid.title, url: vid.url, transcript };
        videos.push(videoObj);
        onEvent('video', videoObj);
        log(`✓ transcript ok (${transcript.length} lines)`);
      } catch (e) {
        const videoObj = { title: vid.title, url: vid.url, error: e.message };
        videos.push(videoObj);
        onEvent('video', videoObj);
        log(`✗ transcript failed: ${e.message}`);
      }
    }

    return { videos, logs, title: playlistTitle };
  } finally {
    await browser.close();
  }
}

// --- API route for playlist ---
app.get('/api/playlist', async (req, res) => {
  const { playlistUrl } = req.query;
  if (!playlistUrl) return res.status(400).json({ error: 'playlistUrl required' });
  try {
    const result = await fetchPlaylist(playlistUrl);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// SSE streaming version
app.get('/api/playlist/stream', async (req, res) => {
  const { playlistUrl } = req.query;
  if (!playlistUrl) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(type, data) {
    res.write(`event:${type}\n`);
    res.write(`data:${JSON.stringify(data)}\n\n`);
  }

  try {
    await fetchPlaylist(playlistUrl, send);
    send('done', 'completed');
  } catch (err) {
    send('error', err.message);
  } finally {
    res.end();
  }
});

// SSE for single video
app.get('/api/transcript/stream', async (req,res)=>{
  const { videoUrl } = req.query;
  if(!videoUrl) return res.status(400).end();
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();

  function send(type,data){res.write(`event:${type}\n`);res.write(`data:${JSON.stringify(data)}\n\n`);}

  try{
    await fetchTranscript(videoUrl, send);
    send('done','completed');
  }catch(err){send('error',err.message);}finally{res.end();}
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`)); 
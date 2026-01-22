const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// 1. GLOBAL CORS MIDDLEWARE
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static('public'));

// 2. HELPER FUNCTIONS
function encodeProxyUrl(url) {
  return Buffer.from(url).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function decodeProxyUrl(encoded) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  return Buffer.from(base64 + '='.repeat(padding), 'base64').toString('utf-8');
}

// 3. THE "SUPER" REWRITER (Combines all fixes)
function rewriteHtml(html, baseUrl, proxyPrefix) {
  let rewritten = html;
  const origin = new URL(baseUrl).origin;

  // A. Block Service Workers (Fixes the "Double Proxy" crash)
  rewritten = rewritten.replace(/navigator\.serviceWorker\.register/g, 'console.log');

  // B. Strip TikTok's Security Headers (CSP) inside HTML
  rewritten = rewritten.replace(/<meta http-equiv="Content-Security-Policy".*?>/gi, '');

  // C. Remove Integrity checks (Fixes GitHub/TikTok breaking)
  rewritten = rewritten.replace(/integrity="sha[^"]*"/gi, '');

  // D. Rewrite all Links (src/href) to point to our proxy
  rewritten = rewritten.replace(/(src|href)=["']([^"']+)["']/gi, (match, attr, url) => {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) return match;
    
    let absoluteUrl = url;
    try {
      if (url.startsWith('//')) absoluteUrl = 'https:' + url;
      else if (url.startsWith('/')) absoluteUrl = origin + url;
      else if (!url.startsWith('http')) absoluteUrl = origin + '/' + url;
      
      const encoded = encodeProxyUrl(absoluteUrl);
      return `${attr}="${proxyPrefix}${encoded}"`;
    } catch (e) {
      return match;
    }
  });

  return rewritten;
}

// 4. MAIN PROXY ROUTE
app.get('/ocho/:url(*)', async (req, res) => {
  let targetUrl = '';
  
  console.log('=== OCHO REQUEST ===', req.path);

  try {
    const encodedUrl = req.params.url;
    if (!encodedUrl) return res.status(400).send('Invalid request');

    // Decode URL
    try {
      const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      targetUrl = decodeProxyUrl(encodedUrl);
      if (queryString) targetUrl += queryString;
      new URL(targetUrl); // Validate
    } catch (e) {
      console.error('URL Error:', e.message);
      return res.status(400).send('Invalid URL encoding');
    }

    console.log('Proxying:', targetUrl);

    // Fetch Target
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity', // Critical fix for node-fetch
        'Connection': 'keep-alive'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // Prepare Response Headers
    const headersToSend = {};
    const contentType = response.headers.get('content-type') || '';

    // A. Security & CORS Headers (The fix for your crash)
    headersToSend['Content-Security-Policy'] = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; style-src * 'unsafe-inline';";
    headersToSend['X-Frame-Options'] = 'ALLOWALL';
    headersToSend['Access-Control-Allow-Origin'] = '*';
    headersToSend['Access-Control-Allow-Methods'] = '*';
    headersToSend['Access-Control-Allow-Headers'] = '*';

    // B. Content Type
    if (contentType) {
      if ((contentType.includes('text/') || contentType.includes('json')) && !contentType.includes('charset')) {
        headersToSend['content-type'] = contentType + '; charset=utf-8';
      } else {
        headersToSend['content-type'] = contentType;
      }
    }

    res.set(headersToSend);

    // Handle Body (HTML vs Binary)
    if (contentType.includes('text/html')) {
      let text = await response.text();
      text = rewriteHtml(text, targetUrl, '/ocho/');
      // Ensure DOCTYPE
      if (!text.toLowerCase().trim().startsWith('<!doctype')) {
         text = '<!DOCTYPE html>\n' + text;
      }
      res.send(text);
    } else {
      // Stream everything else directly
      response.body.pipe(res);
    }

  } catch (error) {
    console.error('Proxy Error:', error.message);
    if (!res.headersSent) res.status(500).send('Proxy Error: ' + error.message);
  }
});

// 5. API ENDPOINT (For your frontend input box)
app.get('/api/encode', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;
    const encoded = encodeProxyUrl(fullUrl);
    res.json({ encoded, proxyUrl: `/ocho/${encoded}` });
  } catch (e) {
    res.status(400).json({ error: 'Invalid URL' });
  }
});

// 6. CATCH-ALL REDIRECT (Fixes the /ttwid/check/ 404s)
// If TikTok tries to load /ttwid/check/, this grabs it and redirects it back to the proxy.
app.all('*', (req, res) => {
  const referer = req.headers.referer;
  
  if (referer && referer.includes('/ocho/')) {
    try {
      // 1. Extract the original site URL from the Referer
      const refPath = new URL(referer).pathname;
      const encodedTarget = refPath.split('/ocho/')[1].split('?')[0]; // grab the base64 part
      const targetOrigin = new URL(decodeProxyUrl(encodedTarget)).origin; // get https://tiktok.com
      
      // 2. Combine it with the path the browser is trying to load
      const fixedUrl = targetOrigin + req.url;
      
      console.log(`Catch-All: Redirecting stray request ${req.url} back to proxy`);
      return res.redirect(`/ocho/${encodeProxyUrl(fixedUrl)}`);
    } catch (e) {
      console.error('Catch-All Error:', e);
    }
  }
  
  res.status(404).send('Not Found');
});

// 7. START SERVER
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Project Ocho is live on 0.0.0.0:${PORT}`);
});

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

// Use raw body parser for POST requests (fixes API calls)
app.use(express.raw({ type: '*/*', limit: '10mb' }));
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

function rewriteHtml(html, baseUrl, proxyPrefix) {
  let rewritten = html;
  const origin = new URL(baseUrl).origin;

  // A. Block Service Workers (The "Zombie" Fix)
  rewritten = rewritten.replace(/navigator\.serviceWorker\.register/g, '(async()=>console.log("SW Blocked"))');

  // B. Strip Security Headers & CSP
  rewritten = rewritten.replace(/<meta http-equiv="Content-Security-Policy".*?>/gi, '');
  rewritten = rewritten.replace(/integrity="sha[^"]*"/gi, '');

  // C. Rewrite Links
  rewritten = rewritten.replace(/(src|href)=["']([^"']+)["']/gi, (match, attr, url) => {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) return match;
    let absoluteUrl = url;
    try {
      if (url.startsWith('//')) absoluteUrl = 'https:' + url;
      else if (url.startsWith('/')) absoluteUrl = origin + url;
      else if (!url.startsWith('http')) absoluteUrl = origin + '/' + url;
      
      const encoded = encodeProxyUrl(absoluteUrl);
      return `${attr}="${proxyPrefix}${encoded}"`;
    } catch (e) { return match; }
  });

  return rewritten;
}

// 3. CORE PROXY LOGIC (Shared by main route and catch-all)
async function doProxyRequest(targetUrl, req, res) {
  console.log(`Proxying: ${req.method} ${targetUrl}`);

  try {
    // Forward Request Headers
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': req.headers.accept || '*/*',
      'Accept-Encoding': 'identity', 
      'Connection': 'keep-alive',
      'Content-Type': req.headers['content-type']
    };

    // Forward Cookies (Critical for APIs)
    if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;
    if (req.headers.referer) headers['Referer'] = targetUrl; // Fake the referer

    const fetchOptions = {
      method: req.method,
      headers: headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    };

    // Forward Body for POST/PUT
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Buffer.isBuffer(req.body)) {
      fetchOptions.body = req.body;
    }

    const response = await fetch(targetUrl, fetchOptions);

    // Prepare Response Headers
    const headersToSend = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; style-src * 'unsafe-inline';",
      'X-Frame-Options': 'ALLOWALL'
    };

    const contentType = response.headers.get('content-type');
    if (contentType) headersToSend['content-type'] = contentType;

    res.set(headersToSend);

    // Handle HTML Rewriting vs Direct Streaming
    if (contentType && contentType.includes('text/html')) {
      let text = await response.text();
      text = rewriteHtml(text, targetUrl, '/ocho/');
      if (!text.toLowerCase().trim().startsWith('<!doctype')) {
         text = '<!DOCTYPE html>\n' + text;
      }
      res.send(text);
    } else {
      response.body.pipe(res);
    }
  } catch (error) {
    console.error(`Proxy Fail: ${targetUrl} - ${error.message}`);
    if (!res.headersSent) res.status(500).end();
  }
}

// 4. THE "KILLER" SERVICE WORKER
// This tricks the browser into unregistering the bad SW
app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.send(`
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', () => {
      self.registration.unregister().then(() => {
        console.log('Zombie Service Worker Killed');
      });
    });
  `);
});

// 5. MAIN ROUTE
app.use('/ocho/:url(*)', (req, res) => {
  const encodedUrl = req.params.url;
  try {
    let targetUrl = decodeProxyUrl(encodedUrl);
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    if (queryString) targetUrl += queryString;
    
    doProxyRequest(targetUrl, req, res);
  } catch (e) {
    res.status(400).send('Invalid URL');
  }
});

// 6. API ENCODER
app.get('/api/encode', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const fullUrl = url.startsWith('http') ? url : 'https://' + url;
  res.json({ encoded: encodeProxyUrl(fullUrl), proxyUrl: `/ocho/${encodeProxyUrl(fullUrl)}` });
});

// 7. INTELLIGENT CATCH-ALL (Fixes 500 Errors on APIs)
app.all('*', (req, res) => {
  const referer = req.headers.referer;
  
  if (referer && referer.includes('/ocho/')) {
    try {
      const refPath = new URL(referer).pathname;
      const encodedTarget = refPath.split('/ocho/')[1].split('?')[0];
      const targetOrigin = new URL(decodeProxyUrl(encodedTarget)).origin;
      
      const fixedUrl = targetOrigin + req.url;
      
      // Instead of redirecting (which breaks POST), we proxy directly
      return doProxyRequest(fixedUrl, req, res);
    } catch (e) {
      console.error('Leak Fix Failed:', e);
    }
  }
  res.status(404).send('Not Found');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Project Ocho listening on 0.0.0.0:${PORT}`);
});

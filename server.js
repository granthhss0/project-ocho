const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS middleware - must be before routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static('public'));

app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

function encodeProxyUrl(url) {
  return Buffer.from(url).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function decodeProxyUrl(encoded) {
  const base64 = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  return Buffer.from(base64 + '='.repeat(padding), 'base64').toString('utf-8');
}

function rewriteHtml(html, baseUrl, proxyPrefix) {
  let rewritten = html;
  
  // Only rewrite HTML href and img src, skip script src
  rewritten = rewritten.replace(
    /(href|src)=["'](https?:\/\/[^"']+)["']/gi,
    (match, attr, url) => {
      // Skip script tags
      if (match.toLowerCase().includes('script')) return match;
      const encoded = encodeProxyUrl(url);
      return `${attr}="${proxyPrefix}${encoded}"`;
    }
  );
  
  return rewritten;
}

app.get('/ocho/:url(*)', async (req, res) => {
  let targetUrl = '';
  
  console.log('=== OCHO REQUEST ===');
  console.log('Path:', req.path);
  console.log('Params:', req.params);
  console.log('Query:', req.query);
  
  try {
    let encodedUrl = req.params.url;
    
    // Validate encoded URL exists
    if (!encodedUrl) {
      return res.status(400).send('Invalid request');
    }
    
    // Handle query parameters - they should stay as-is, not be decoded
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    
    try {
      targetUrl = decodeProxyUrl(encodedUrl);
      // Append original query params to decoded URL
      if (queryString) {
        targetUrl += queryString;
      }
    } catch (decodeError) {
      console.error('Decode error:', decodeError);
      return res.status(400).send('Invalid URL encoding');
    }
    
    // Validate decoded URL
    try {
      new URL(targetUrl);
    } catch (urlError) {
      console.error('Invalid URL:', targetUrl);
      return res.status(400).send('Invalid URL');
    }
    
    console.log('Proxying:', targetUrl);
    
    const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'identity', // <--- This is the CORS/Crashing fix. 
                                   // It tells the site not to compress.
                                   // node-fetch v2 struggles with compressed streams.
    'Connection': 'keep-alive'
};
    
    const response = await fetch(targetUrl, {
      headers: fetchHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000) // 15 second timeout
    });
    
    if (!response.ok) {
      console.error('Fetch failed:', response.status, response.statusText);
      throw new Error(`HTTP ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type') || '';
    console.log('Content-Type:', contentType);
    let body;
    
    // Check content length to avoid memory issues
    const contentLength = parseInt(response.headers.get('content-length') || '0');
    if (contentLength > 10 * 1024 * 1024) { // 10MB limit
      console.error('Content too large:', contentLength);
      return res.status(413).end();
    }
    
    // Determine what we're actually serving
    if (contentType.includes('text/html')) {
      const text = await response.text();
      if (text.length > 5 * 1024 * 1024) { // 5MB HTML limit
        console.error('HTML too large');
        return res.status(413).end();
      }
      console.log('HTML size:', text.length);
      body = rewriteHtml(text, targetUrl, '/ocho/');
      
      // Ensure DOCTYPE for standards mode
      if (!body.toLowerCase().startsWith('<!doctype')) {
        body = '<!DOCTYPE html>\n' + body;
      }
    } else if (contentType.includes('text/') || contentType.includes('javascript') || contentType.includes('json')) {
      // For text content, just pass through
      body = await response.text();
      if (body.length > 10 * 1024 * 1024) { // 10MB text limit
        console.error('Text content too large');
        return res.status(413).end();
      }
      console.log('Text size:', body.length);
    } else {
      // Binary content - strict limit
      if (contentLength > 5 * 1024 * 1024) { // 5MB binary limit
        console.error('Binary too large:', contentLength);
        return res.status(413).end();
      }
      const buffer = await response.arrayBuffer();
      body = Buffer.from(buffer);
      console.log('Binary size:', body.length);
    }
    
    const headersToSend = {};
    
    // CRITICAL: Ensure proper content-type with charset
    if (contentType) {
      // Always add charset for text content
      if (contentType.includes('text/') || contentType.includes('javascript') || contentType.includes('json')) {
        if (!contentType.includes('charset')) {
          headersToSend['content-type'] = contentType + '; charset=utf-8';
        } else {
          headersToSend['content-type'] = contentType;
        }
      } else {
        headersToSend['content-type'] = contentType;
      }
    }
    
    // Copy safe headers
    ['cache-control', 'expires'].forEach(header => {
      const value = response.headers.get(header);
      if (value) headersToSend[header] = value;
    });
    
    // CRITICAL: Remove ALL restrictive headers
    // Don't copy any security headers that could interfere
    
    // CRITICAL CORS configuration to prevent CORB
    headersToSend['Access-Control-Allow-Origin'] = '*';
    headersToSend['Access-Control-Allow-Methods'] = '*';
    headersToSend['Access-Control-Allow-Headers'] = '*';
    headersToSend['Access-Control-Expose-Headers'] = '*';
    
    // Tell browser this is a CORS proxy and to allow everything
    headersToSend['Timing-Allow-Origin'] = '*';
    
    res.set(headersToSend);
    
    // Send response safely
    try {
      res.send(body);
      console.log('Response sent successfully');
    } catch (sendError) {
      console.error('Error sending response:', sendError);
      if (!res.headersSent) {
        res.status(500).end();
      }
    }
    
  } catch (error) {
    console.error('Proxy error:', error.message, error.stack);
    
    // Check if response was already sent
    if (res.headersSent) {
      return;
    }
    
    // Silent fail for assets
    const urlToCheck = targetUrl || req.params.url || '';
    if (urlToCheck.match(/\.(js|css|jpg|jpeg|png|gif|webp|svg|ico|woff|woff2|ttf|json|mp4|webm)/i)) {
      return res.status(404).end();
    }
    
    // Error page for HTML
    res.status(500).type('text/html').send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              background: #0a0a0a; 
              color: #fff; 
              padding: 40px; 
              text-align: center; 
            }
            h1 { font-weight: 300; }
            p { color: #666; margin: 20px 0; }
            a { color: #888; text-decoration: none; }
            a:hover { color: #fff; }
          </style>
        </head>
        <body>
          <h1>blocked</h1>
          <p>this site has bot protection</p>
          <a href="/">← back</a>
        </body>
      </html>
    `);
  }
});

app.get('/api/encode', (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'URL parameter required' });
  }
  
  try {
    let fullUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      fullUrl = 'https://' + url;
    }
    
    new URL(fullUrl);
    
    const encoded = encodeProxyUrl(fullUrl);
    res.json({ 
      encoded,
      proxyUrl: `/ocho/${encoded}`
    });
  } catch (error) {
    res.status(400).json({ error: 'Invalid URL' });
  }
});

app.get('*', (req, res) => {
  const referer = req.headers.referer;
  
  if (referer && referer.includes('/ocho/')) {
    try {
      // Find the encoded target from the referer
      const refPath = new URL(referer).pathname;
      const encodedTarget = refPath.split('/ocho/')[1].split('?')[0];
      const targetOrigin = new URL(decodeProxyUrl(encodedTarget)).origin;
      
      // Re-encode the leaked path
      const actualTarget = targetOrigin + req.url;
      console.log('Redirecting Leak:', actualTarget);
      return res.redirect(`/ocho/${encodeProxyUrl(actualTarget)}`);
    } catch (e) {
      console.error('Leak redirect failed');
    }
  }
  
  res.status(404).end(); // Send empty 404, NO HTML (prevents the "<" error)
});

// ... (your encoding/decoding functions)

function rewriteHtml(html, baseUrl, proxyPrefix) {
  let rewritten = html;
  const origin = new URL(baseUrl).origin;

  // 1. Remove SRI (Integrity) - THIS IS WHY GITHUB BREAKS
  rewritten = rewritten.replace(/integrity="sha[^"]*"/gi, '');

  // 2. Comprehensive Rewrite (including scripts!)
  // This regex catches src and href and wraps them in your Base64 proxy
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

// ... inside your app.get('/ocho/:url(*)') route ...

    const headersToSend = {}; // Make sure this line exists!

    // CRITICAL: Add these lines RIGHT HERE:
    headersToSend['Content-Security-Policy'] = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; style-src * 'unsafe-inline';";
    headersToSend['X-Frame-Options'] = 'ALLOWALL';
    headersToSend['Access-Control-Allow-Origin'] = '*';
    headersToSend['Access-Control-Allow-Methods'] = '*';
    headersToSend['Access-Control-Allow-Headers'] = '*';

    // ... continue with the rest of your header copying logic ...
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Project Ocho is now listening on 0.0.0.0:${PORT}`);
});

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

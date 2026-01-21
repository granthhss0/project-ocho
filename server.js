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

app.get('/proxy/:url(*)', async (req, res) => {
  let targetUrl = '';
  
  try {
    const encodedUrl = req.params.url;
    
    // Validate encoded URL exists
    if (!encodedUrl) {
      return res.status(400).send('Invalid request');
    }
    
    try {
      targetUrl = decodeProxyUrl(encodedUrl);
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
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    };
    
    const response = await fetch(targetUrl, {
      headers: fetchHeaders,
      redirect: 'follow',
      timeout: 10000
    });
    
    if (!response.ok) {
      console.error('Fetch failed:', response.status, response.statusText);
      throw new Error(`HTTP ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type') || '';
    let body;
    
    // Determine what we're actually serving
    if (contentType.includes('text/html')) {
      body = await response.text();
      body = rewriteHtml(body, targetUrl, '/proxy/');
    } else if (contentType.includes('javascript') || contentType.includes('json')) {
      // For JS/JSON, return as text to avoid CORB
      body = await response.text();
    } else if (contentType.includes('text/css')) {
      body = await response.text();
    } else if (contentType.includes('image') || contentType.includes('font') || contentType.includes('video')) {
      // Binary content
      body = await response.buffer();
    } else {
      // Default to buffer for unknown types
      body = await response.buffer();
    }
    
    const headersToSend = {};
    
    // Set correct content-type
    if (contentType) {
      headersToSend['content-type'] = contentType;
    }
    
    // Copy safe headers
    ['cache-control', 'expires', 'etag', 'last-modified'].forEach(header => {
      const value = response.headers.get(header);
      if (value) headersToSend[header] = value;
    });
    
    // Remove problematic headers
    delete headersToSend['x-content-type-options'];
    delete headersToSend['content-security-policy'];
    delete headersToSend['x-frame-options'];
    
    // Force CORS headers
    headersToSend['Access-Control-Allow-Origin'] = '*';
    headersToSend['Cross-Origin-Resource-Policy'] = 'cross-origin';
    headersToSend['Cross-Origin-Embedder-Policy'] = 'unsafe-none';
    
    res.set(headersToSend);
    res.send(body);
    
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Project Ocho running on http://0.0.0.0:${PORT}`);
});

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

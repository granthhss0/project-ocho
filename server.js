const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

// Serve service worker from root
app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// URL encoding/decoding functions
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

// Rewrite URLs in HTML content
function rewriteHtml(html, baseUrl, proxyPrefix) {
  let rewritten = html;
  
  // Rewrite absolute URLs
  rewritten = rewritten.replace(
    /(href|src|action)=["']https?:\/\/[^"']+["']/gi,
    (match) => {
      const urlMatch = match.match(/=["']([^"']+)["']/);
      if (urlMatch) {
        const originalUrl = urlMatch[1];
        const encoded = encodeProxyUrl(originalUrl);
        return match.replace(originalUrl, `${proxyPrefix}${encoded}`);
      }
      return match;
    }
  );
  
  // Rewrite protocol-relative URLs
  rewritten = rewritten.replace(
    /(href|src|action)=["']\/\/[^"']+["']/gi,
    (match) => {
      const urlMatch = match.match(/=["']\/\/([^"']+)["']/);
      if (urlMatch) {
        const originalUrl = 'https://' + urlMatch[1];
        const encoded = encodeProxyUrl(originalUrl);
        return match.replace('//' + urlMatch[1], `${proxyPrefix}${encoded}`);
      }
      return match;
    }
  );
  
  // Rewrite relative URLs
  rewritten = rewritten.replace(
    /(href|src|action)=["']\/[^/"'][^"']*["']/gi,
    (match) => {
      const urlMatch = match.match(/=["']([^"']+)["']/);
      if (urlMatch) {
        const relativePath = urlMatch[1];
        const absoluteUrl = new URL(relativePath, baseUrl).href;
        const encoded = encodeProxyUrl(absoluteUrl);
        return match.replace(relativePath, `${proxyPrefix}${encoded}`);
      }
      return match;
    }
  );
  
  return rewritten;
}

// Rewrite CSS content
function rewriteCss(css, baseUrl, proxyPrefix) {
  return css.replace(
    /url\(["']?([^)"']+)["']?\)/gi,
    (match, url) => {
      try {
        const absoluteUrl = new URL(url.trim(), baseUrl).href;
        const encoded = encodeProxyUrl(absoluteUrl);
        return `url("${proxyPrefix}${encoded}")`;
      } catch {
        return match;
      }
    }
  );
}

// Main proxy endpoint
app.get('/proxy/:url(*)', async (req, res) => {
  try {
    const encodedUrl = req.params.url;
    const targetUrl = decodeProxyUrl(encodedUrl);
    
    console.log('Proxying:', targetUrl);
    
    // Fetch the target URL
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      },
      redirect: 'follow'
    });
    
    const contentType = response.headers.get('content-type') || '';
    
    // Get response body
    let body;
    if (contentType.includes('text/html')) {
      body = await response.text();
      body = rewriteHtml(body, targetUrl, '/proxy/');
    } else if (contentType.includes('text/css')) {
      body = await response.text();
      body = rewriteCss(body, targetUrl, '/proxy/');
    } else if (contentType.includes('javascript')) {
      body = await response.text();
      // Basic JS rewriting
      body = body.replace(
        /(window\.location|document\.location)(\.href)?(\s*=\s*["']([^"']+)["'])/g,
        (match, loc, href, assign, url) => {
          try {
            const absoluteUrl = new URL(url, targetUrl).href;
            const encoded = encodeProxyUrl(absoluteUrl);
            return `${loc}${href || ''}${assign.replace(url, '/proxy/' + encoded)}`;
          } catch {
            return match;
          }
        }
      );
    } else {
      // Binary content (images, etc.)
      body = await response.buffer();
    }
    
    // Copy relevant headers
    const headersToSend = {};
    ['content-type', 'cache-control', 'expires'].forEach(header => {
      const value = response.headers.get(header);
      if (value) headersToSend[header] = value;
    });
    
    // Remove CSP headers that might block functionality
    delete headersToSend['content-security-policy'];
    delete headersToSend['x-frame-options'];
    
    res.set(headersToSend);
    res.send(body);
    
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).send(`
      <html>
        <head>
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              background: #0a0a0a; 
              color: #fff; 
              padding: 40px; 
              text-align: center; 
            }
            h1 { font-weight: 300; }
            a { color: #888; text-decoration: none; }
            a:hover { color: #fff; }
          </style>
        </head>
        <body>
          <h1>error</h1>
          <p>${error.message}</p>
          <a href="/">← back</a>
        </body>
      </html>
    `);
  }
});

// API endpoint to encode URLs
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
      proxyUrl: `/proxy/${encoded}`
    });
  } catch (error) {
    res.status(400).json({ error: 'Invalid URL' });
  }
});

app.listen(PORT, () => {
  console.log(`Project Ocho running on http://localhost:${PORT}`);
});

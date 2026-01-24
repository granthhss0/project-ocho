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

// Use raw body parser for POST requests
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

  // Block Service Workers aggressively
  rewritten = rewritten.replace(/navigator\.serviceWorker/g, 'navigator.__blockedServiceWorker');
  rewritten = rewritten.replace(/'serviceWorker'/g, "'__blockedServiceWorker'");
  rewritten = rewritten.replace(/"serviceWorker"/g, '"__blockedServiceWorker"');

  // Strip ALL security-related meta tags
  rewritten = rewritten.replace(/<meta http-equiv="Content-Security-Policy".*?>/gi, '');
  rewritten = rewritten.replace(/<meta.*?name="referrer".*?>/gi, '');
  rewritten = rewritten.replace(/integrity="[^"]*"/gi, '');
  rewritten = rewritten.replace(/crossorigin="[^"]*"/gi, '');

  // Remove CORB-triggering attributes
  rewritten = rewritten.replace(/\s+crossorigin/gi, '');
  
  // Rewrite fetch calls to go through proxy
  rewritten = rewritten.replace(/fetch\s*\(/g, 'window.__proxyFetch(');

  // Rewrite Links - USE RELATIVE PATHS, NOT ABSOLUTE
  rewritten = rewritten.replace(/(src|href)=["']([^"']+)["']/gi, (match, attr, url) => {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#') || url.startsWith('javascript:')) return match;
    
    // Skip if already proxied
    if (url.includes('/ocho/')) return match;
    
    let absoluteUrl = url;
    try {
      if (url.startsWith('//')) absoluteUrl = 'https:' + url;
      else if (url.startsWith('/')) absoluteUrl = origin + url;
      else if (!url.startsWith('http')) {
        // Handle relative URLs
        const baseUrlObj = new URL(baseUrl);
        const basePath = baseUrlObj.pathname.substring(0, baseUrlObj.pathname.lastIndexOf('/') + 1);
        absoluteUrl = baseUrlObj.origin + basePath + url;
      }
      
      const encoded = encodeProxyUrl(absoluteUrl);
      // Return RELATIVE path, not absolute
      return `${attr}="${proxyPrefix}${encoded}"`;
    } catch (e) { 
      console.error('URL rewrite error:', e, url);
      return match; 
    }
  });

  // Inject proxy helper script at the top of <head>
  const proxyScript = `
    <script>
      // Set correct base URL for the proxy
      (function() {
        const currentOrigin = window.location.origin;
        const targetOrigin = '${origin}';
        
        // Intercept ALL navigation attempts
        document.addEventListener('click', function(e) {
          const link = e.target.closest('a');
          if (link && link.href) {
            const url = link.href;
            // If it's trying to go to the real site, stop it and proxy it
            if (url.startsWith(targetOrigin) || (!url.startsWith(currentOrigin) && !url.startsWith('javascript:') && !url.startsWith('mailto:') && !url.startsWith('tel:') && !url.startsWith('#'))) {
              e.preventDefault();
              const fullUrl = url.startsWith('http') ? url : targetOrigin + (url.startsWith('/') ? '' : '/') + url;
              const encoded = btoa(fullUrl).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
              window.location.href = currentOrigin + '/ocho/' + encoded;
            }
          }
        }, true);
        
        // Proxy fetch wrapper
        window.__proxyFetch = function(url, options) {
          if (typeof url === 'string' && !url.startsWith('/ocho/') && !url.startsWith('data:') && !url.startsWith('blob:')) {
            let fullUrl = url;
            if (!url.startsWith('http')) {
              fullUrl = url.startsWith('/') ? targetOrigin + url : targetOrigin + '/' + url;
            }
            const encoded = btoa(fullUrl).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
            url = currentOrigin + '/ocho/' + encoded;
          }
          return fetch(url, options);
        };
        
        // Override fetch globally
        const originalFetch = window.fetch;
        window.fetch = function(url, options) {
          if (typeof url === 'string' && !url.startsWith('/ocho/') && !url.startsWith('data:') && !url.startsWith('blob:')) {
            return window.__proxyFetch(url, options);
          }
          return originalFetch(url, options);
        };
        
        // Override XMLHttpRequest
        const originalXHROpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
          if (typeof url === 'string' && !url.startsWith('/ocho/') && !url.startsWith('data:') && !url.startsWith('blob:')) {
            let fullUrl = url;
            if (!url.startsWith('http')) {
              fullUrl = url.startsWith('/') ? targetOrigin + url : targetOrigin + '/' + url;
            }
            const encoded = btoa(fullUrl).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
            url = currentOrigin + '/ocho/' + encoded;
          }
          return originalXHROpen.call(this, method, url, ...args);
        };
        
        // Block service worker registration
        if ('serviceWorker' in navigator) {
          Object.defineProperty(navigator, 'serviceWorker', {
            get: () => undefined
          });
        }
      })();
    </script>
  `;

  rewritten = rewritten.replace(/<head>/i, '<head>' + proxyScript);

  // Inject base tag - REMOVE THIS, it causes the wrong origin issue
  // The proxy script handles URL resolution instead

  return rewritten;
}

// CORE PROXY LOGIC (Shared by main route and catch-all)
async function doProxyRequest(targetUrl, req, res) {
  console.log(`Proxying: ${req.method} ${targetUrl}`);

  try {
    // Forward Request Headers
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': req.headers.accept || '*/*',
      'Accept-Encoding': 'identity', 
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'Connection': 'keep-alive'
    };

    // Forward important headers
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;
    if (req.headers.referer) {
      try {
        const targetOrigin = new URL(targetUrl).origin;
        headers['Referer'] = targetOrigin;
      } catch (e) {
        headers['Referer'] = targetUrl;
      }
    }

    const fetchOptions = {
      method: req.method,
      headers: headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    };

    // Forward Body for POST/PUT
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Buffer.isBuffer(req.body)) {
      fetchOptions.body = req.body;
    }

    const response = await fetch(targetUrl, fetchOptions);

    // Get content length to check size
    const contentLength = parseInt(response.headers.get('content-length') || '0');
    const MAX_SIZE = 50 * 1024 * 1024; // 50MB limit
    
    if (contentLength > MAX_SIZE) {
      console.warn(`Response too large: ${contentLength} bytes, streaming directly`);
      // For huge responses, just stream without rewriting
      res.set('Content-Type', response.headers.get('content-type'));
      return response.body.pipe(res).on('finish', () => {
        if (response.body.destroy) response.body.destroy();
      });
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    
    const headersToSend = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
      'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; style-src * 'unsafe-inline';",
      'X-Frame-Options': 'ALLOWALL',
      'Content-Type': contentType
    };

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) headersToSend['set-cookie'] = setCookie;

    res.set(headersToSend);
    res.status(response.status);

    // Only rewrite HTML, stream everything else
    if (contentType.includes('text/html') && contentLength < 5 * 1024 * 1024) {
      // Only rewrite HTML smaller than 5MB
      const text = await response.text();
      const rewritten = rewriteHtml(text, targetUrl, '/ocho/');
      const final = rewritten.toLowerCase().trim().startsWith('<!doctype') 
        ? rewritten 
        : '<!DOCTYPE html>\n' + rewritten;
      res.send(final);
    } else {
      // Stream everything else to avoid loading into memory
      response.body.pipe(res).on('finish', () => {
        if (response.body.destroy) response.body.destroy();
      }).on('error', (err) => {
        console.error('Stream error:', err);
        if (response.body.destroy) response.body.destroy();
        if (!res.headersSent) res.status(500).end();
      });
    }
  } catch (error) {
    console.error(`Proxy Fail: ${targetUrl} - ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  } finally {
    if (global.gc) {
      global.gc();
    }
  }
}

// 4. THE "KILLER" SERVICE WORKER
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

// 5. API ENCODER
app.get('/api/encode', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const fullUrl = url.startsWith('http') ? url : 'https://' + url;
  res.json({ encoded: encodeProxyUrl(fullUrl), proxyUrl: `/ocho/${encodeProxyUrl(fullUrl)}` });
});

// 6. MAIN ROUTE
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

// 7. ENHANCED CATCH-ALL - Handles leaked API requests
app.all('*', (req, res) => {
  const referer = req.headers.referer;
  
  // Try to fix leaked requests by reconstructing the target URL
  if (referer && referer.includes('/ocho/')) {
    try {
      // Extract the base URL from referer
      const refPath = new URL(referer).pathname;
      
      // Split correctly - may have /ocho/encodedurl/extra or just /ocho/encodedurl
      const parts = refPath.split('/ocho/');
      if (parts.length > 1) {
        const encodedPart = parts[1].split('/')[0].split('?')[0];
        const targetOrigin = new URL(decodeProxyUrl(encodedPart)).origin;
        
        // Construct the full target URL
        const fixedUrl = targetOrigin + req.url;
        
        console.log(`Catch-all fixing: ${req.url} -> ${fixedUrl}`);
        
        // Proxy the request directly (don't redirect)
        return doProxyRequest(fixedUrl, req, res);
      }
    } catch (e) {
      console.error('Catch-all fix failed:', e.message, 'for URL:', req.url);
    }
  }
  
  console.log(`404 Not Found: ${req.url} (referer: ${referer || 'none'})`);
  res.status(404).json({ error: 'Not Found', path: req.url });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Project Ocho listening on 0.0.0.0:${PORT}`);
});

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
        
        // Track in-flight requests to prevent loops
        const inFlightRequests = new Set();
        
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
        
        // Override fetch globally - FIX: Don't intercept if already proxied
        const originalFetch = window.fetch;
        window.fetch = function(url, options) {
          // Skip if already a proxy URL or special protocol
          if (typeof url === 'string') {
            if (url.startsWith('/ocho/') || url.startsWith('data:') || url.startsWith('blob:')) {
              return originalFetch(url, options);
            }
            
            // Prevent request loops
            if (inFlightRequests.has(url)) {
              console.warn('Preventing fetch loop for:', url);
              return Promise.reject(new Error('Request loop prevented'));
            }
            
            // Mark as in-flight
            inFlightRequests.add(url);
            
            let fullUrl = url;
            if (!url.startsWith('http')) {
              fullUrl = url.startsWith('/') ? targetOrigin + url : targetOrigin + '/' + url;
            }
            const encoded = btoa(fullUrl).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
            const proxiedUrl = currentOrigin + '/ocho/' + encoded;
            
            // Call original fetch and cleanup
            return originalFetch(proxiedUrl, options).finally(() => {
              inFlightRequests.delete(url);
            });
          }
          return originalFetch(url, options);
        };
        
        // Override XMLHttpRequest - FIX: Don't intercept if already proxied
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
      signal: AbortSignal.timeout(60000) // Increased to 60 seconds
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
      const stream = response.body.pipe(res);
      
      stream.on('finish', () => {
        if (response.body.destroy) response.body.destroy();
      });
      
      stream.on('error', (err) => {
        console.error('Stream error:', err.message);
        if (response.body.destroy) response.body.destroy();
        if (!res.headersSent) res.status(500).end();
      });
      
      // Handle client disconnect
      req.on('close', () => {
        console.log('Client disconnected, aborting stream');
        if (response.body.destroy) response.body.destroy();
      });
    }
  } catch (error) {
    console.error(`Proxy Fail: ${targetUrl} - ${error.message}`);
    
    // Handle specific error types
    if (error.name === 'AbortError' || error.message.includes('aborted')) {
      console.log('Request timeout or aborted');
      if (!res.headersSent) {
        res.status(504).json({ 
          error: 'Request timeout', 
          message: 'The target server took too long to respond. Try a simpler page or refresh.' 
        });
      }
    } else if (error.code === 'ECONNREFUSED') {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Connection refused', message: 'Could not connect to target server' });
      }
    } else {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Proxy error', message: error.message });
      }
    }
  } finally {
    if (global.gc) {
      global.gc();
    }
  }
}

// 4. THE "KILLER" SERVICE WORKER - AGGRESSIVE VERSION
app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.send(`
    // Aggressively kill any service worker
    self.addEventListener('install', (e) => {
      self.skipWaiting();
      e.waitUntil(
        caches.keys().then((names) => {
          return Promise.all(names.map(name => caches.delete(name)));
        })
      );
    });
    
    self.addEventListener('activate', (e) => {
      e.waitUntil(
        self.registration.unregister().then(() => {
          return self.clients.matchAll();
        }).then((clients) => {
          clients.forEach(client => client.navigate(client.url));
        })
      );
    });
    
    // Don't intercept ANY requests
    self.addEventListener('fetch', (e) => {
      e.respondWith(fetch(e.request));
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
  
  console.log(`Catch-all hit: ${req.method} ${req.url}`);
  console.log(`Referer: ${referer}`);
  
  // Try to fix leaked requests by reconstructing the target URL
  if (referer) {
    try {
      let targetOrigin = null;
      
      // Extract origin from referer
      if (referer.includes('/ocho/')) {
        const refPath = new URL(referer).pathname;
        const parts = refPath.split('/ocho/');
        if (parts.length > 1) {
          const encodedPart = parts[1].split('/')[0].split('?')[0];
          targetOrigin = new URL(decodeProxyUrl(encodedPart)).origin;
        }
      }
      
      // If we found a target origin, proxy the request
      if (targetOrigin) {
        const fixedUrl = targetOrigin + req.url;
        console.log(`✓ Catch-all proxying: ${req.url} -> ${fixedUrl}`);
        return doProxyRequest(fixedUrl, req, res);
      }
    } catch (e) {
      console.error('Catch-all parsing error:', e.message);
    }
  }
  
  // If no referer or parsing failed, return 404
  console.log(`✗ 404 Not Found: ${req.url}`);
  res.status(404).json({ 
    error: 'Not Found', 
    path: req.url,
    hint: 'This request could not be proxied. The page may need to be refreshed.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Project Ocho listening on 0.0.0.0:${PORT}`);
});

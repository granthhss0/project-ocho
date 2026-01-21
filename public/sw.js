// public/sw.js
self.addEventListener('install', (event) => {
    self.skipWaiting(); // Force update
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim()); // Take control of page immediately
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 1. Don't touch requests to our own internal proxy files
    if (url.origin === location.origin) {
        if (url.pathname === '/sw.js' || url.pathname === '/rewriter.js' || url.pathname === '/inject.js') {
            return;
        }
    }

    // 2. If the request is already going to /main, let it through
    if (url.pathname.startsWith('/main')) return;

    // 3. THE FIX: If a request "leaks" (doesn't have /main), 
    // we use the current page's URL to fix it.
    let targetUrl = event.request.url;
    
    // If it's a relative path (e.g., /api/v1), it will have our origin.
    // We need to attach the target site's origin to it.
    if (url.origin === location.origin) {
        const client = event.clientId;
        // This part is tricky, we'll let the Server-Side catch-all (Step 1) 
        // handle the origin fixing via the Referer header for now.
        return; 
    }

    event.respondWith(
        fetch(`/main?url=${encodeURIComponent(targetUrl)}`)
    );
});

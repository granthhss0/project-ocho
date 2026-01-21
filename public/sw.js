// public/sw.js
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip our own internal files (index.html, rewriter.js, etc.)
    if (url.origin === location.origin && !url.pathname.startsWith('/main')) {
        // Check if it's a relative path from a proxied site
        // If the referrer is /main, we should proxy this request too
        if (event.request.referrer.includes('/main?url=')) {
            const refUrl = new URL(event.request.referrer);
            const targetOrigin = new URL(decodeURIComponent(refUrl.searchParams.get('url'))).origin;
            const newTarget = targetOrigin + url.pathname + url.search;
            
            event.respondWith(fetch(`/main?url=${encodeURIComponent(newTarget)}`));
            return;
        }
        return; 
    }

    // Standard proxy interception
    if (!url.pathname.startsWith('/main')) {
        event.respondWith(
            fetch(`/main?url=${encodeURIComponent(event.request.url)}`)
        );
    }
});

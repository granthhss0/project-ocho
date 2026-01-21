// public/sw.js
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);

    // 1. Ignore requests to our own server (like the UI or the SW itself)
    if (url.origin === location.origin) {
        return;
    }

    // 2. Intercept all other requests and route them through our relay
    // This catches links, scripts, and fetch() calls made by the proxied site
    const proxiedUrl = `/main?url=${encodeURIComponent(request.url)}`;

    event.respondWith(
        fetch(proxiedUrl, {
            method: request.method,
            headers: request.headers,
            mode: request.mode,
            credentials: request.credentials
        })
    );
});

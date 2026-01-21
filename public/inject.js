// public/inject.js
(function() {
    const PROXY_PREFIX = '/main?url=';
    const originUrl = new URL(new URLSearchParams(window.location.search).get('url')).origin;

    // 1. Hook Fetch
    const oldFetch = window.fetch;
    window.fetch = function(url, options) {
        if (typeof url === 'string' && !url.startsWith(window.location.origin)) {
            let fullUrl = url.startsWith('/') ? originUrl + url : url;
            url = PROXY_PREFIX + encodeURIComponent(fullUrl);
        }
        return oldFetch(url, options);
    };

    // 2. Hook XMLHttpRequest (For older API calls)
    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string' && !url.startsWith(window.location.origin)) {
            let fullUrl = url.startsWith('/') ? originUrl + url : url;
            url = PROXY_PREFIX + encodeURIComponent(fullUrl);
        }
        return oldOpen.apply(this, arguments);
    };
})();

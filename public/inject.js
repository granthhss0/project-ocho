// public/inject.js
(function() {
    const prefix = '/main?url=';
    const currentUrl = new URLSearchParams(window.location.search).get('url');
    if (!currentUrl) return;
    const origin = new URL(currentUrl).origin;

    // Fix Fetch
    const nativeFetch = window.fetch;
    window.fetch = function(uri, options) {
        if (typeof uri === 'string' && !uri.startsWith('http') && !uri.startsWith(prefix)) {
            uri = prefix + encodeURIComponent(origin + (uri.startsWith('/') ? '' : '/') + uri);
        }
        return nativeFetch(uri, options);
    };

    // Fix XMLHttpRequests (Old school AJAX TikTok uses)
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string' && !url.startsWith('http') && !url.startsWith(prefix)) {
            url = prefix + encodeURIComponent(origin + (url.startsWith('/') ? '' : '/') + url);
        }
        nativeOpen.apply(this, arguments);
    };

    console.log("Ocho Injector Active: Intercepting background traffic.");
})();

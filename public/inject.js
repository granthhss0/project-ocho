(function() {
    const PROXY_URL = '/main?url=';
    const targetOrigin = new URL(new URLSearchParams(window.location.search).get('url')).origin;

    // Hook Fetch calls
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string' && !input.startsWith('http') && !input.startsWith(PROXY_URL)) {
            input = PROXY_URL + encodeURIComponent(targetOrigin + (input.startsWith('/') ? '' : '/') + input);
        }
        return originalFetch(input, init);
    };

    // Hook Script insertions (helps with TikTok's dynamic loading)
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.tagName === 'SCRIPT' && node.src && !node.src.includes(window.location.host)) {
                    const originalSrc = node.src;
                    node.src = window.location.origin + PROXY_URL + encodeURIComponent(originalSrc);
                }
            });
        });
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
})();

const Rewriter = {
    html: (code, origin) => {
        const proxyPrefix = '/main?url=';
        
        // Inject a small script to the top of the <head> to handle dynamic JS fetches
        let rewritten = code.replace('<head>', `<head>
            <script>
                // Local Injection to hook browser APIs
                (function() {
                    const origin = "${origin}";
                    const prefix = "/main?url=";
                    const oldFetch = window.fetch;
                    window.fetch = function(url, options) {
                        if (typeof url === 'string' && !url.startsWith('http') && !url.startsWith(prefix)) {
                            url = prefix + encodeURIComponent(origin + (url.startsWith('/') ? '' : '/') + url);
                        }
                        return oldFetch(url, options);
                    };
                })();
            </script>
        `);

        // Replace src and href attributes
        // Regex looks for src="..." or href="..."
        rewritten = rewritten.replace(/(src|href|action)="([^"]*)"/gi, (match, attr, url) => {
            // Don't proxy data URIs or already proxied links
            if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith(proxyPrefix)) {
                return match;
            }

            let newUrl = url;

            // Convert relative to absolute
            if (url.startsWith('/') && !url.startsWith('//')) {
                newUrl = origin + url;
            } else if (url.startsWith('//')) {
                newUrl = 'https:' + url;
            }

            // Wrap in proxy prefix
            return `${attr}="${proxyPrefix}${encodeURIComponent(newUrl)}"`;
        });

        return rewritten;
    }
};

// Export for Node.js use
if (typeof module !== 'undefined') {
    module.exports = Rewriter;
}

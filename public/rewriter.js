// public/rewriter.js
const Rewriter = {
    // This adds your proxy prefix to any URL it finds
    proxifyUrl: (url, proxyPrefix) => {
        if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;
        // Logic: if it's already proxied, leave it. If not, add prefix.
        return url.startsWith(proxyPrefix) ? url : proxyPrefix + encodeURIComponent(url);
    },

    // This scans an HTML string and replaces attributes
    html: (code, proxyPrefix) => {
        return code
            .replace(/(src|href|action|srcset)="([^"]*)"/gi, (match, attr, url) => {
                return `${attr}="${Rewriter.proxifyUrl(url, proxyPrefix)}"`;
            })
            .replace(/url\(['"]?([^'"\)]+)['"]?\)/gi, (match, url) => {
                return `url("${Rewriter.proxifyUrl(url, proxyPrefix)}")`;
            });
    }
};

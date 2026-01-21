const Rewriter = {
    html: (code, origin) => {
        const proxyPrefix = '/main?url=';
        
        // Inject the helper script at the top to fix background JS requests
        let rewritten = code.replace('<head>', `<head><script src="/inject.js"></script>`);

        // Comprehensive Regex: Catches src, href, action, and data-src
        const urlRegex = /(src|href|action|data-src)="([^"]*)"/gi;
        
        rewritten = rewritten.replace(urlRegex, (match, attr, url) => {
            if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith(proxyPrefix) || url.startsWith('#')) {
                return match;
            }

            let fullUrl = url;
            if (url.startsWith('//')) {
                fullUrl = 'https:' + url;
            } else if (url.startsWith('/')) {
                fullUrl = origin + url;
            } else if (!url.startsWith('http')) {
                // Handle relative paths like "style.css"
                fullUrl = origin + '/' + url;
            }

            return `${attr}="${proxyPrefix}${encodeURIComponent(fullUrl)}"`;
        });

        return rewritten;
    }
};

if (typeof module !== 'undefined') module.exports = Rewriter;

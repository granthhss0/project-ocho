const Rewriter = {
    html: (code, origin) => {
        const proxyPrefix = '/main?url=';
        
        // Inject the helper script
        let rewritten = code.replace('<head>', `<head><script src="/inject.js"></script>`);

        // Update URLs in HTML attributes
        const regex = /(src|href|action)="([^"]*)"/gi;
        rewritten = rewritten.replace(regex, (match, attr, url) => {
            if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith(proxyPrefix)) {
                return match;
            }

            let absoluteUrl = url;
            if (url.startsWith('/') && !url.startsWith('//')) {
                absoluteUrl = origin + url;
            } else if (url.startsWith('//')) {
                absoluteUrl = 'https:' + url;
            }

            return `${attr}="${proxyPrefix}${encodeURIComponent(absoluteUrl)}"`;
        });

        return rewritten;
    }
};

if (typeof module !== 'undefined') module.exports = Rewriter;

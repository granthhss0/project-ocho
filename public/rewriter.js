// public/rewriter.js
const Rewriter = {
    html: (code, origin) => {
        const proxyPrefix = '/main?url=';
        
        // Inject our hook at the very beginning of the <head>
        let rewritten = code.replace('<head>', `<head><script src="/inject.js"></script>`);

        // Fix standard attributes
        rewritten = rewritten.replace(/(src|href|action)="([^"]*)"/gi, (match, attr, url) => {
            if (url.startsWith('data:') || url.startsWith('blob:')) return match;
            
            let newUrl = url;
            if (url.startsWith('/') && !url.startsWith('//')) newUrl = origin + url;
            else if (url.startsWith('//')) newUrl = 'https:' + url;
            
            return `${attr}="${proxyPrefix}${encodeURIComponent(newUrl)}"`;
        });

        return rewritten;
    }
};
if (typeof module !== 'undefined') module.exports = Rewriter;

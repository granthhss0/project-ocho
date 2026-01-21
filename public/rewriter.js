// public/rewriter.js
const Rewriter = {
    html: (code, origin) => {
        const proxyPrefix = '/main?url=';

        return code.replace(/(src|href|action)="([^"]*)"/gi, (match, attr, url) => {
            let newUrl = url;

            // Handle relative paths (e.g., /style.css -> https://tiktok.com/style.css)
            if (url.startsWith('/') && !url.startsWith('//')) {
                newUrl = origin + url;
            } 
            // Handle protocol-relative (e.g., //cdn.com)
            else if (url.startsWith('//')) {
                newUrl = 'https:' + url;
            }

            // Proxify the final absolute URL
            return `${attr}="${proxyPrefix}${encodeURIComponent(newUrl)}"`;
        });
    }
};

if (typeof module !== 'undefined') module.exports = Rewriter;

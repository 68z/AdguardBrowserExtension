/**
 * Used for new type of redirects, i.e. click2load.html
 */
export const redirectsCache = (function () {
    const cache = [];

    const add = (url) => {
        cache.push(url);
    };

    const hasUrl = (url) => {
        return cache.includes(url);
    };

    return {
        add,
        hasUrl,
    };
})();

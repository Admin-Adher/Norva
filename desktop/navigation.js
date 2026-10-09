'use strict';
function isSameAppOrigin(target, application) {
    try {
        const destination = new URL(target), origin = new URL(application);
        return ['http:', 'https:'].includes(destination.protocol) && destination.origin === origin.origin;
    } catch { return false; }
}
module.exports = { isSameAppOrigin };

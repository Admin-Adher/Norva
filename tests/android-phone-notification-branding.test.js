'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../clients/android-phone/app/src/main');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('background FCM and native notifications use the same dedicated Norva status icon', () => {
    const manifest = read('AndroidManifest.xml');
    assert.match(manifest, /android:name="com\.google\.firebase\.messaging\.default_notification_icon"\s+android:resource="@drawable\/ic_norva_notification"/);
    assert.match(manifest, /android:name="com\.google\.firebase\.messaging\.default_notification_color"\s+android:resource="@color\/norva_accent"/);
    const service = read('java/tv/norva/phone/NorvaMessagingService.java');
    assert.match(service, /setSmallIcon\(R\.drawable\.ic_norva_notification\)/);
    assert.doesNotMatch(service, /setSmallIcon\(R\.drawable\.ic_launcher\)/);
    assert.match(service, /setColor\(getColor\(R\.color\.norva_accent\)\)/);
    assert.match(service, /setLargeIcon\(BitmapFactory\.decodeResource\(getResources\(\), R\.drawable\.norva_app_icon\)\)/);
});

test('status drawable is a transparent monochrome mark, not a bitmap tile', () => {
    const drawable = read('res/drawable/ic_norva_notification.xml');
    assert.match(drawable, /<vector\s/);
    assert.match(drawable, /android:width="24dp"/);
    assert.match(drawable, /android:height="24dp"/);
    assert.equal((drawable.match(/<path\s/g) || []).length, 1);
    assert.match(drawable, /android:fillColor="#FFFFFFFF"/);
    assert.doesNotMatch(drawable, /<bitmap|<shape|<layer-list|@drawable\/norva_app_icon/);
});

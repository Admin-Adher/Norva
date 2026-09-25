package tv.norva.phone;

import org.junit.Test;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public final class ProviderHtmlResponseTest {
    private boolean html(String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        return BoundedRangeDataSource.isHtmlDocument(bytes, bytes.length);
    }

    @Test public void confirmsHtmlRatherThanTrustingTheFileExtension() {
        assertTrue(html("\uFEFF \r\n<!DOCTYPE HTML><html><body>Unavailable</body>"));
        assertTrue(html("<HTML lang='fr'>"));
        assertTrue(html("<?xml version='1.0'?><html xmlns='http://www.w3.org/1999/xhtml'>"));
        assertFalse(html("<html"));
        assertFalse(html("<htmlish>"));
        assertFalse(html("#EXTM3U\n#EXT-X-VERSION:3"));
        assertFalse(html("WEBVTT\n\n00:00.000 --> 00:01.000\n<html>"));
        assertFalse(html("\u0000\u0000\u0000 ftypisom"));
        assertFalse(html("<?xml version='1.0'?><MPD>"));
    }

    @Test public void onlyConfirmedHtmlStopsRecoveryAndDiagnosticsContainNoBody() {
        IOException error = new BoundedRangeDataSource.HtmlResponseException();
        assertTrue(BoundedRangeDataSource.isHtmlResponse(new IOException("wrapped", error)));
        assertFalse(BoundedRangeDataSource.isHtmlResponse(new IOException("network")));
        assertFalse(BoundedRangeDataSource.isHtmlResponse(null));
        assertEquals("Provider returned an HTML document", error.getMessage());
    }
}

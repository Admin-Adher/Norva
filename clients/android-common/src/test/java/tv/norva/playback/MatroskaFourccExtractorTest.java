package tv.norva.playback;

import static org.junit.Assert.*;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.extractor.*;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Map;
import org.junit.Test;

public final class MatroskaFourccExtractorTest {
    private static byte[] join(byte[]... fields) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] field : fields) out.write(field, 0, field.length);
        return out.toByteArray();
    }
    private static byte[] element(int id, byte[] body) {
        byte[] tag = id > 0xffffff ? new byte[]{(byte)(id>>>24),(byte)(id>>>16),(byte)(id>>>8),(byte)id}
                : id > 255 ? new byte[]{(byte)(id>>>8),(byte)id} : new byte[]{(byte)id};
        return join(tag, body.length < 127 ? new byte[]{(byte)(128|body.length)}
                : new byte[]{(byte)(64|(body.length>>>8)),(byte)body.length}, body);
    }
    private static byte[] entry(int number, int type, String codec, String tag, byte[] initialization) {
        byte[] bitmap = new byte[40]; bitmap[0]=40;
        System.arraycopy(tag.getBytes(StandardCharsets.US_ASCII),0,bitmap,16,4);
        return element(0xae, join(element(0xd7,new byte[]{(byte)number}),element(0x83,new byte[]{(byte)type}),
                element(0x86,codec.getBytes(StandardCharsets.US_ASCII)),element(0x63a2,join(bitmap,initialization))));
    }
    private static byte[] header(byte[]... entries) {
        return element(0x18538067,element(0x1654ae6b,join(entries)));
    }
    @Test public void onlyExactVideoTrackFourccIsAdmitted() {
        for (String tag : new String[]{"XVID","DX50"}) {
            byte[] data=header(entry(7,1,"V_MS/VFW/FOURCC",tag,new byte[]{0,0,1,32}));
            Map<Integer,byte[]> tracks=MatroskaFourccExtractor.parseTracks(data,data.length);
            assertEquals(1,tracks.size()); assertArrayEquals(new byte[]{0,0,1,32},tracks.get(7));
        }
        for (String codec : new String[]{"V_MPEG4/ISO/ASP","A_MS/ACM"}) {
            byte[] data=header(entry(1,1,codec,"XVID",new byte[0]));
            assertTrue(MatroskaFourccExtractor.parseTracks(data,data.length).isEmpty());
        }
        for (String tag : new String[]{"WVC1","H263","ZZZZ","DIVX"}) {
            byte[] data=header(entry(1,1,"V_MS/VFW/FOURCC",tag,new byte[0]));
            assertTrue(MatroskaFourccExtractor.parseTracks(data,data.length).isEmpty());
        }
        byte[] audio=header(entry(1,2,"V_MS/VFW/FOURCC","XVID",new byte[0]));
        assertTrue(MatroskaFourccExtractor.parseTracks(audio,audio.length).isEmpty());
    }
    @Test public void truncatedOversizedAndDuplicateHeadersCannotReclassifyATrack() {
        byte[] data=header(entry(1,1,"V_MS/VFW/FOURCC","XVID",new byte[0]));
        for(int length=0;length<data.length;length++) assertNull(MatroskaFourccExtractor.parseTracks(data,length));
        byte[] duplicate=header(entry(1,1,"V_MS/VFW/FOURCC","XVID",new byte[0]),entry(1,1,"V_MS/VFW/FOURCC","ZZZZ",new byte[0]));
        assertTrue(MatroskaFourccExtractor.parseTracks(duplicate,duplicate.length).isEmpty());
        byte[] invalid=data.clone(); invalid[invalid.length-40]=39;
        assertTrue(MatroskaFourccExtractor.parseTracks(invalid,invalid.length).isEmpty());
        byte[] oversized=new byte[MatroskaFourccExtractor.MAX_HEADER_BYTES+1];
        assertTrue(MatroskaFourccExtractor.parseTracks(oversized,oversized.length).isEmpty());
    }
    @Test public void formatCorrectionPreservesSamplesAndSeekCoordinates() throws Exception {
        byte[] data=header(entry(7,1,"V_MS/VFW/FOURCC","XVID",new byte[0]));
        byte[] original=data.clone(); int[] peek={0}; Format[] received={null}; Object[] sample={null};
        ExtractorInput input=(ExtractorInput)Proxy.newProxyInstance(ExtractorInput.class.getClassLoader(),new Class<?>[]{ExtractorInput.class},(p,m,a)->{
            if(m.getName().equals("getPosition"))return 0L;
            if(m.getName().equals("resetPeekPosition")){peek[0]=0;return null;}
            if(m.getName().equals("peek")){int n=Math.min((int)a[2],data.length-peek[0]);if(n==0)return -1;System.arraycopy(data,peek[0],(byte[])a[0],(int)a[1],n);peek[0]+=n;return n;}
            throw new AssertionError(m.getName());
        });
        Fake fake=new Fake(); Extractor wrapped=new MatroskaFourccExtractor(fake);
        TrackOutput sink=(TrackOutput)Proxy.newProxyInstance(TrackOutput.class.getClassLoader(),new Class<?>[]{TrackOutput.class},(p,m,a)->{
            if(m.getName().equals("format"))received[0]=(Format)a[0];
            if(m.getName().equals("sampleMetadata"))sample[0]=a;
            return null;
        });
        wrapped.init(new ExtractorOutput(){public TrackOutput track(int id,int type){return sink;}public void endTracks(){}public void seekMap(SeekMap map){}});
        wrapped.read(input,new PositionHolder());assertEquals(0,peek[0]);assertArrayEquals(original,data);
        TrackOutput video=fake.output.track(7,C.TRACK_TYPE_VIDEO);
        Format unknown=new Format.Builder().setSampleMimeType(MimeTypes.VIDEO_UNKNOWN).setWidth(1280).setHeight(720).build();
        video.format(unknown);assertEquals(MimeTypes.VIDEO_MP4V,received[0].sampleMimeType);assertEquals(1280,received[0].width);
        fake.output.track(8,C.TRACK_TYPE_VIDEO).format(unknown);assertSame(unknown,received[0]);
        fake.output.track(7,C.TRACK_TYPE_AUDIO).format(unknown);assertSame(unknown,received[0]);
        Format h264=new Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).build();video.format(h264);assertSame(h264,received[0]);
        video.sampleMetadata(3000000L,1,40,12,null);assertArrayEquals(new Object[]{3000000L,1,40,12,null},(Object[])sample[0]);
        wrapped.seek(567890L,204000000L);assertEquals(567890L,fake.position);assertEquals(204000000L,fake.time);
    }
    @Test public void interruptedHeaderReadCanBeRetriedWithoutConsumingBytes() throws Exception {
        byte[] data=header(entry(7,1,"V_MS/VFW/FOURCC","XVID",new byte[0]));
        int[] peek={0};boolean[] interrupted={false};
        ExtractorInput input=(ExtractorInput)Proxy.newProxyInstance(ExtractorInput.class.getClassLoader(),new Class<?>[]{ExtractorInput.class},(p,m,a)->{
            if(m.getName().equals("getPosition"))return 0L;
            if(m.getName().equals("resetPeekPosition")){peek[0]=0;return null;}
            if(m.getName().equals("peek")){
                if(!interrupted[0]){interrupted[0]=true;throw new java.io.IOException("temporary fixture read");}
                int n=Math.min((int)a[2],data.length-peek[0]);if(n==0)return -1;
                System.arraycopy(data,peek[0],(byte[])a[0],(int)a[1],n);peek[0]+=n;return n;
            }
            throw new AssertionError(m.getName());
        });
        Fake fake=new Fake();Extractor wrapped=new MatroskaFourccExtractor(fake);Format[] received={null};
        TrackOutput sink=(TrackOutput)Proxy.newProxyInstance(TrackOutput.class.getClassLoader(),new Class<?>[]{TrackOutput.class},(p,m,a)->{
            if(m.getName().equals("format"))received[0]=(Format)a[0];return null;
        });
        wrapped.init(new ExtractorOutput(){public TrackOutput track(int id,int type){return sink;}public void endTracks(){}public void seekMap(SeekMap map){}});
        try{wrapped.read(input,new PositionHolder());fail("Read must report the temporary error");}catch(java.io.IOException expected){}
        assertEquals(0,peek[0]);wrapped.read(input,new PositionHolder());assertEquals(0,peek[0]);
        fake.output.track(7,C.TRACK_TYPE_VIDEO).format(new Format.Builder().setSampleMimeType(MimeTypes.VIDEO_UNKNOWN).build());
        assertEquals(MimeTypes.VIDEO_MP4V,received[0].sampleMimeType);
        assertTrue(received[0].initializationData.isEmpty());
    }
    static final class Fake implements Extractor {
        ExtractorOutput output;long position,time;
        public boolean sniff(ExtractorInput i){return true;}public void init(ExtractorOutput o){output=o;}
        public int read(ExtractorInput i,PositionHolder p){return RESULT_CONTINUE;}public void seek(long p,long t){position=p;time=t;}public void release(){}
    }
}

package tv.norva.playback;

import static org.junit.Assert.*;
import androidx.media3.common.C;
import androidx.media3.common.DataReader;
import androidx.media3.common.Format;
import androidx.media3.common.util.ParsableByteArray;
import androidx.media3.decoder.DecoderInputBuffer;
import androidx.media3.decoder.VideoDecoderOutputBuffer;
import androidx.media3.extractor.DefaultExtractorInput;
import androidx.media3.extractor.DummyTrackOutput;
import androidx.media3.extractor.Extractor;
import androidx.media3.extractor.ExtractorOutput;
import androidx.media3.extractor.PositionHolder;
import androidx.media3.extractor.SeekMap;
import androidx.media3.extractor.TrackOutput;
import androidx.media3.extractor.mkv.MatroskaExtractor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.io.File;
import java.nio.file.Files;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Every decoded plane must equal FFmpeg's reference, including delayed B frames.
 * Synthetic moving test pattern: Advanced Simple, QPEL, 4MV, B frames, in-band VOL.
 * A first-frame/count-only assertion cannot detect the real phone's corruption. */
@RunWith(AndroidJUnit4.class)
@androidx.media3.common.util.UnstableApi
public final class Mpeg4VideoDecoderInstrumentedTest {
    private static byte[] asset(String name) throws Exception {
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] bytes = new byte[8192]; int size;
            while ((size = in.read(bytes)) >= 0) out.write(bytes, 0, size);
            return out.toByteArray();
        }
    }
    @Test public void advancedSimplePixelsMatchReferenceThroughEosAndSeekFlush() throws Exception {
        assertTrue("Required local MPEG-4 JNI missing", Mpeg4VideoDecoder.isAvailable());
        List<String> reference = new ArrayList<>();
        for (String line : new String(asset("asp-qpel-reference.framemd5"), StandardCharsets.US_ASCII).split("\n"))
            if (!line.isEmpty() && !line.startsWith("#")) reference.add(line.substring(line.lastIndexOf(',') + 1).trim());
        assertEquals(300, reference.size());
        Demux demux = new Demux(asset("s_xvid_vfw_asp_qpel.mkv"));
        assertNotNull(demux.format);
        Mpeg4VideoDecoder decoder = new Mpeg4VideoDecoder(demux.format);
        try {
            assertFrames(reference, decode(decoder, demux.packets, 0));
            // A decoder flushed after EOF must discard its old references and
            // preroll without exposing pictures before the requested seek.
            decoder.flush();
            List<String> afterSeek = decode(decoder, demux.packets, 3_000_000L);
            assertEquals(reference.subList(reference.size() - afterSeek.size(), reference.size()), afterSeek);
            assertTrue(afterSeek.size() >= 220 && afterSeek.size() <= 226);
        } finally { decoder.release(); decoder.release(); }
    }
    @Test public void privateRealClipMatchesEveryReferenceFrame() throws Exception {
        File root=InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null);
        File clip=new File(root,"mpeg4-real.mkv"), referenceFile=new File(root,"mpeg4-real.framemd5");
        if ("true".equals(InstrumentationRegistry.getArguments().getString("norvaRequireRealMpeg4"))) {
            assertTrue("Private real clip missing",clip.isFile()&&referenceFile.isFile());
        } else org.junit.Assume.assumeTrue("Private real clip not supplied",clip.isFile()&&referenceFile.isFile());
        List<String> reference=new ArrayList<>();
        for(String line:Files.readAllLines(referenceFile.toPath(),StandardCharsets.US_ASCII))
            if(!line.isEmpty()&&!line.startsWith("#"))reference.add(line.substring(line.lastIndexOf(',')+1).trim());
        assertTrue(reference.size()>100);
        Demux demux=new Demux(Files.readAllBytes(clip.toPath()));
        Mpeg4VideoDecoder decoder=new Mpeg4VideoDecoder(demux.format);
        try {assertFrames(reference,decode(decoder,demux.packets,0));} finally {decoder.release();}
    }
    private static void assertFrames(List<String> reference,List<String> actual) {
        assertEquals("Decoded frame count",reference.size(),actual.size());
        int mismatches=0,first=-1;
        for(int i=0;i<reference.size();i++)if(!reference.get(i).equals(actual.get(i))){mismatches++;if(first<0)first=i;}
        assertEquals("Pixel hash mismatches; first="+first,0,mismatches);
    }
    private static List<String> decode(Mpeg4VideoDecoder decoder, List<Packet> packets, long startUs) throws Exception {
        decoder.setOutputStartTimeUs(startUs); decoder.setOutputMode(C.VIDEO_OUTPUT_MODE_SURFACE_YUV);
        List<String> hashes = new ArrayList<>(); int next = 0; long previous = Long.MIN_VALUE;
        for (int tick = 0; tick < 10000; tick++) {
            VideoDecoderOutputBuffer out = decoder.dequeueOutputBuffer();
            if (out != null) {
                if (out.isEndOfStream()) { out.release(); assertEquals(packets.size()+1, next); return hashes; }
                assertTrue("Reordered timestamp regressed", out.timeUs >= previous);
                assertTrue(out.timeUs >= startUs); previous = out.timeUs;
                int length = out.width*out.height + 2*((out.width+1)/2)*((out.height+1)/2);
                ByteBuffer bytes = out.data.duplicate(); bytes.position(0); bytes.limit(length);
                if("true".equals(InstrumentationRegistry.getArguments().getString("norvaMpeg4Diagnostic"))
                        && (hashes.size()%40==0 || hashes.size()==18 || hashes.size()==19)) {
                    File root=InstrumentationRegistry.getInstrumentation().getTargetContext().getExternalFilesDir(null);
                    byte[] raw=new byte[length];bytes.duplicate().get(raw);
                    Files.write(new File(root,"frame-"+out.width+"x"+out.height+"-"+hashes.size()+".yuv").toPath(),raw);
                }
                MessageDigest md5 = MessageDigest.getInstance("MD5"); md5.update(bytes);
                StringBuilder hash = new StringBuilder(); for (byte value : md5.digest()) hash.append(String.format(java.util.Locale.ROOT,"%02x", value & 255));
                hashes.add(hash.toString()); out.release();
            }
            DecoderInputBuffer input = decoder.dequeueInputBuffer();
            if (input != null) {
                if (next == packets.size()) input.addFlag(C.BUFFER_FLAG_END_OF_STREAM);
                else {
                    assertTrue("Input requested after EOS", next < packets.size());
                    Packet packet = packets.get(next); input.ensureSpaceForWrite(packet.bytes.length);
                    input.data.put(packet.bytes); input.timeUs = packet.timeUs; input.setFlags(packet.flags); input.flip();
                }
                next++; decoder.queueInputBuffer(input);
            }
        }
        throw new AssertionError("Decoder did not drain to EOS");
    }
    private static final class Packet {
        byte[] bytes; long timeUs; int flags;
        Packet(byte[] bytes, long timeUs, int flags) { this.bytes=bytes; this.timeUs=timeUs; this.flags=flags; }
    }
    private static final class Demux implements ExtractorOutput, TrackOutput {
        Format format; List<Packet> packets = new ArrayList<>(); ByteArrayOutputStream data = new ByteArrayOutputStream();
        Demux(byte[] bytes) throws Exception {
            Extractor extractor = new MatroskaFourccExtractor(new MatroskaExtractor()); extractor.init(this);
            int[] position={0};
            DataReader reader=(target, offset, length)->{if(position[0]>=bytes.length)return -1;int size=Math.min(length,bytes.length-position[0]);System.arraycopy(bytes,position[0],target,offset,size);position[0]+=size;return size;};
            DefaultExtractorInput input=new DefaultExtractorInput(reader,0,bytes.length); PositionHolder seek=new PositionHolder();
            try { for(int iteration=0;iteration<100000;iteration++) {
                int result=extractor.read(input,seek); if(result==Extractor.RESULT_END_OF_INPUT)return;
                if(result==Extractor.RESULT_SEEK){position[0]=(int)seek.position;input=new DefaultExtractorInput(reader,seek.position,bytes.length);}
            }} finally {extractor.release();}
            throw new AssertionError("Fixture extractor did not finish");
        }
        @Override public TrackOutput track(int id,int type){return type==C.TRACK_TYPE_VIDEO?this:new DummyTrackOutput();}
        @Override public void endTracks(){}
        @Override public void seekMap(SeekMap map){}
        @Override public void format(Format format){this.format=format;}
        @Override public int sampleData(DataReader input,int length,boolean allowEnd,int part)throws IOException{
            byte[] bytes=new byte[length];int read=input.read(bytes,0,length);if(read>0)data.write(bytes,0,read);return read;
        }
        @Override public void sampleData(ParsableByteArray input,int length,int part){byte[] bytes=new byte[length];input.readBytes(bytes,0,length);data.write(bytes,0,length);}
        @Override public void sampleMetadata(long time,int flags,int size,int offset,CryptoData crypto){
            assertNull(crypto);byte[] bytes=data.toByteArray();int end=bytes.length-offset;
            packets.add(new Packet(Arrays.copyOfRange(bytes,end-size,end),time,flags));
            data.reset();data.write(bytes,end,offset);
        }
    }
}

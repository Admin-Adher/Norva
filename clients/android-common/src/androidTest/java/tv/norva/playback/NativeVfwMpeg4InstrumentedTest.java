package tv.norva.playback;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.C;
import androidx.media3.common.Tracks;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.InputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Decode the legacy XVID layout with the real PlayerActivity, including Resume. */
@RunWith(AndroidJUnit4.class)
@androidx.media3.common.util.UnstableApi
public final class NativeVfwMpeg4InstrumentedTest {
    @Test public void legacyXvidRendersResumesAndCloses() throws Exception {
        Instrumentation ins=InstrumentationRegistry.getInstrumentation();
        Context target=ins.getTargetContext();
        File fixture=new File(target.getCacheDir(),"native-xvid.mkv");
        try(InputStream input=ins.getContext().getAssets().open("s_xvid_vfw_aac.mkv")) { Files.copy(input,fixture.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING); }
        String activityName=target.getPackageName()+".PlayerActivity";
        Instrumentation.ActivityMonitor monitor=ins.addMonitor(activityName,null,false);
        Activity activity=null;
        // Both real players use HTTP for online media. Phone's local lane is
        // encrypted downloads; TV does not support file:// sources.
        try (FixtureOrigin origin=new FixtureOrigin(Files.readAllBytes(fixture.toPath()))) {
            target.startActivity(new Intent().setClassName(target,activityName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra("url",origin.url()).putExtra("title","Norva legacy XVID QA")
                    .putExtra("itemType","movie").putExtra("resumeSeconds",3));
            activity=ins.waitForMonitorWithTimeout(monitor,10000);
            assertNotNull(activity);final Activity opened=activity;
            java.lang.reflect.Field field=activity.getClass().getDeclaredField("player");field.setAccessible(true);
            ExoPlayer[] holder=new ExoPlayer[1];ins.runOnMainSync(()->{try{holder[0]=(ExoPlayer)field.get(opened);}catch(Exception e){throw new AssertionError(e);}});
            ExoPlayer player=holder[0];assertNotNull(player);
            long[] observed={0,0,0};boolean[] selected={false};long start=SystemClock.elapsedRealtime();
            while(SystemClock.elapsedRealtime()-start<20000) {
                ins.runOnMainSync(()->{
                    assertNull("Playback failed: "+safeError(player.getPlayerError()),player.getPlayerError());
                    observed[0]=player.getCurrentPosition();
                    observed[1]=player.getVideoDecoderCounters()==null?0:player.getVideoDecoderCounters().renderedOutputBufferCount;
                    observed[2]=player.getAudioDecoderCounters()==null?0:player.getAudioDecoderCounters().renderedOutputBufferCount;
                    for(Tracks.Group group:player.getCurrentTracks().getGroups()) if(group.getType()==C.TRACK_TYPE_VIDEO)
                        for(int i=0;i<group.length;i++) if(group.isTrackSelected(i)) selected[0]=MimeTypes.VIDEO_MP4V.equals(group.getTrackFormat(i).sampleMimeType);
                });
                if(observed[0]>=4000&&observed[1]>10&&observed[2]>10&&selected[0])break;
                SystemClock.sleep(100);
            }
            assertTrue("No decoded MPEG-4 video",selected[0]&&observed[1]>10);
            assertTrue("No audio progress",observed[2]>10);
            assertTrue("Resume position lost",observed[0]>=4000&&observed[0]<10000);
            ins.runOnMainSync(()->player.seekTo(7000));SystemClock.sleep(1200);
            ins.runOnMainSync(()->{assertNull(player.getPlayerError());assertTrue(player.getCurrentPosition()>=7000);opened.onBackPressed();});
            ins.waitForIdleSync();assertTrue(activity.isFinishing()||activity.isDestroyed());
        } finally {
            if(activity!=null&&!activity.isDestroyed()){final Activity opened=activity;ins.runOnMainSync(opened::finish);}
            ins.removeMonitor(monitor);fixture.delete();
        }
    }
    private static String safeError(Throwable error) {
        StringBuilder result=new StringBuilder();
        for(int depth=0;error!=null&&depth<8;depth++,error=error.getCause())
            result.append(error.getClass().getSimpleName()).append(": ").append(error.getMessage()).append("; ");
        return result.toString();
    }
    private static final class FixtureOrigin implements AutoCloseable {
        final ServerSocket server;
        final byte[] bytes;
        FixtureOrigin(byte[] bytes) throws IOException {
            this.bytes=bytes;server=new ServerSocket(0,8,InetAddress.getByName("127.0.0.1"));
            Thread accept=new Thread(()->{
                while(!server.isClosed())try{
                    Socket socket=server.accept();Thread serve=new Thread(()->serve(socket),"vfw-response");
                    serve.setDaemon(true);serve.start();
                }catch(IOException ignored){}
            },"vfw-origin");accept.setDaemon(true);accept.start();
        }
        String url(){return "http://127.0.0.1:"+server.getLocalPort()+"/fixture.mkv";}
        void serve(Socket socket){
            try(Socket current=socket){
                current.setSoTimeout(5000);
                BufferedReader reader=new BufferedReader(new InputStreamReader(current.getInputStream(),StandardCharsets.US_ASCII));
                String line;int start=0,end=bytes.length-1;boolean range=false;
                while((line=reader.readLine())!=null&&!line.isEmpty()){
                    if(line.toLowerCase(java.util.Locale.ROOT).startsWith("range: bytes=")){
                        range=true;String[] bounds=line.substring(line.indexOf('=')+1).split("-",-1);
                        start=Integer.parseInt(bounds[0]);if(!bounds[1].isEmpty())end=Math.min(end,Integer.parseInt(bounds[1]));
                    }
                }
                OutputStream out=current.getOutputStream();
                if(start> end){out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */"+bytes.length+"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));return;}
                out.write(("HTTP/1.1 "+(range?"206 Partial Content":"200 OK")+"\r\nContent-Type: video/x-matroska\r\nAccept-Ranges: bytes\r\nContent-Length: "+(end-start+1)+"\r\n"
                        +(range?"Content-Range: bytes "+start+"-"+end+"/"+bytes.length+"\r\n":"")+"Connection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.write(bytes,start,end-start+1);out.flush();
            }catch(Exception ignored){}
        }
        @Override public void close()throws IOException{server.close();}
    }
}

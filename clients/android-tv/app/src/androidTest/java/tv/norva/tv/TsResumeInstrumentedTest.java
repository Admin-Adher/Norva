package tv.norva.tv;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.view.KeyEvent;
import androidx.media3.common.*;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real TV source factory, decoder and surface; no injected MediaSource. */
@UnstableApi @RunWith(AndroidJUnit4.class)
public final class TsResumeInstrumentedTest {
 @Test public void exactResumeAndBackwardSeekThenBack() throws Exception {
  Instrumentation ins=InstrumentationRegistry.getInstrumentation();
  byte[] bytes;
  try(InputStream in=ins.getContext().getAssets().open("long-gop.ts");ByteArrayOutputStream out=new ByteArrayOutputStream()) {
   byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1)out.write(b,0,n);bytes=out.toByteArray();
  }
  Instrumentation.ActivityMonitor monitor=ins.addMonitor(PlayerActivity.class.getName(),null,false);
  Activity activity=null;
  try(Origin origin=new Origin(bytes)) {
   ins.getTargetContext().startActivity(new Intent(ins.getTargetContext(),PlayerActivity.class)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(PlayerActivity.EXTRA_URL,origin.url())
    .putExtra(PlayerActivity.EXTRA_TITLE,"TS television resume QA").putExtra(PlayerActivity.EXTRA_ITEM_TYPE,"movie"));
   activity=ins.waitForMonitorWithTimeout(monitor,20000);assertNotNull(activity);
   java.lang.reflect.Field field=PlayerActivity.class.getDeclaredField("player");field.setAccessible(true);
   ExoPlayer player=(ExoPlayer)field.get(activity);assertNotNull(player);
   verify(ins,player,origin.url(),17000,true);
   verify(ins,player,origin.url(),5000,false);
   ins.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
   long deadline=SystemClock.elapsedRealtime()+3000;
   while(!activity.isFinishing()&&SystemClock.elapsedRealtime()<deadline)SystemClock.sleep(50);
   assertTrue("Back must close the player",activity.isFinishing());
  } finally {
   Activity a=activity;if(a!=null)ins.runOnMainSync(a::finish);
   ins.removeMonitor(monitor);
  }
 }
 private void verify(Instrumentation ins,ExoPlayer player,String url,long target,boolean reset)throws Exception {
  CountDownLatch frames=new CountDownLatch(1);AtomicInteger count=new AtomicInteger();
  AtomicReference<PlaybackException> error=new AtomicReference<>();long[] m={-1,-1,-1};
  Player.Listener listener=new Player.Listener(){
   @Override public void onPlayerError(PlaybackException e){error.set(e);frames.countDown();}
  };
  androidx.media3.exoplayer.video.VideoFrameMetadataListener videoListener=(pts,release,format,mediaFormat)->{
    int i=count.getAndIncrement();
    if(i==0){m[0]=pts;m[1]=SystemClock.elapsedRealtime();}
    if(i==1){m[2]=SystemClock.elapsedRealtime();frames.countDown();}
   };
  ins.runOnMainSync(()->{
   player.pause();player.addListener(listener);player.setVideoFrameMetadataListener(videoListener);
   if(reset){player.stop();player.setMediaItem(MediaItem.fromUri(url),target);player.prepare();}
   else player.seekTo(target);
   player.play();
  });
  try {
   assertTrue("Two decoded TV frames expected",frames.await(35,TimeUnit.SECONDS));assertNull(error.get());
   assertTrue("Wrong decoded resume timestamp: "+m[0],Math.abs(m[0]/1000-target)<750);
   assertTrue("TV freezes on future keyframe",m[2]-m[1]<1000);
  } finally {ins.runOnMainSync(()->{player.pause();player.clearVideoFrameMetadataListener(videoListener);player.removeListener(listener);});}
 }
 private static final class Origin implements AutoCloseable {
  final byte[] bytes;final ServerSocket socket;final Thread thread;volatile boolean closed;
  Origin(byte[] bytes)throws Exception {
   this.bytes=bytes;socket=new ServerSocket(0,8,InetAddress.getByName("127.0.0.1"));
   thread=new Thread(()->{while(!closed){try{serve(socket.accept());}catch(IOException e){if(!closed)throw new RuntimeException(e);}}});
   thread.setDaemon(true);thread.start();
  }
  String url(){return "http://127.0.0.1:"+socket.getLocalPort()+"/fixture.ts";}
  void serve(Socket client) {
   try(Socket connection=client){
    connection.setSoTimeout(5000);
    BufferedReader in=new BufferedReader(new InputStreamReader(connection.getInputStream(),StandardCharsets.US_ASCII));
    String first=in.readLine(),line;int start=0,end=bytes.length-1;boolean partial=false;
    while((line=in.readLine())!=null&&!line.isEmpty())if(line.toLowerCase(java.util.Locale.ROOT).startsWith("range: bytes=")) {
     String[] range=line.substring(line.indexOf('=')+1).split("-",-1);
     start=Integer.parseInt(range[0]);if(!range[1].isEmpty())end=Math.min(end,Integer.parseInt(range[1]));partial=true;
    }
    OutputStream out=connection.getOutputStream();
    if(start<0||start>=bytes.length||end<start){out.write("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));return;}
    String headers="HTTP/1.1 "+(partial?"206 Partial Content":"200 OK")+"\r\nContent-Type: video/mp2t\r\nAccept-Ranges: bytes\r\nContent-Length: "+(end-start+1)+"\r\n";
    if(partial)headers+="Content-Range: bytes "+start+"-"+end+"/"+bytes.length+"\r\n";
    out.write((headers+"Connection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
    if(first!=null&&!first.startsWith("HEAD "))out.write(bytes,start,end-start+1);out.flush();
   }catch(IOException ignored){/* Player seeks cancel the previous request. */}
  }
  public void close()throws Exception{closed=true;socket.close();thread.join(1000);}
 }
}
package tv.norva.phone;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.util.Log;
import androidx.media3.common.*;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.ByteArrayDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.extractor.*;
import androidx.media3.extractor.ts.TsExtractor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Test-only decode pre-roll experiment. No production factory is changed. */
@UnstableApi @RunWith(AndroidJUnit4.class)
public final class TsPrerollExperimentTest {
 @Test public void compareLongGopResume() throws Exception {
  Instrumentation ins=InstrumentationRegistry.getInstrumentation();
  byte[] bytes=fixture(ins,"long-gop.ts");
   for(long resume:new long[]{5000,17000,25000}) {
    for(boolean preroll:new boolean[]{false,true}) run(ins,bytes,"long-gop",resume,preroll,0);
   }
 }
 @Test public void compareNetworkCostAcrossGopLengths() throws Exception {
  Instrumentation ins=InstrumentationRegistry.getInstrumentation();
  for(String name:new String[]{"long-gop","short-gop"}) {
   byte[] bytes=fixture(ins,name+".ts");
   for(int order=0;order<2;order++) {
    for(boolean preroll:order==0?new boolean[]{false,true}:new boolean[]{true,false})
     run(ins,bytes,name,17000,preroll,262144);
   }
  }
 }
 private byte[] fixture(Instrumentation ins,String name)throws Exception {
  try(InputStream in=ins.getContext().getAssets().open(name);ByteArrayOutputStream out=new ByteArrayOutputStream()) {
   byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1)out.write(b,0,n);return out.toByteArray();
  }
 }
 private void run(Instrumentation ins,byte[] bytes,String fixture,long resume,boolean preroll,int rate) throws Exception {
  Instrumentation.ActivityMonitor monitor=ins.addMonitor(PlayerActivity.class.getName(),null,false);
  Activity activity=null; AtomicReference<ExoPlayer> ref=new AtomicReference<>();
  AtomicReference<PlaybackException> error=new AtomicReference<>();
  CountDownLatch frames=new CountDownLatch(1); long[] m={-1,-1,-1,-1,-1};
  AtomicInteger count=new AtomicInteger(); long[] started={0};
  AtomicLong delivered=new AtomicLong();
  try (FirstFrameFixtureInstrumentedTest.FixtureHttpServer server = new FirstFrameFixtureInstrumentedTest.FixtureHttpServer(bytes,"video/mp2t")) {
   ins.getTargetContext().startActivity(new Intent(ins.getTargetContext(),PlayerActivity.class)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(PlayerActivity.EXTRA_URL,server.url())
    .putExtra(PlayerActivity.EXTRA_TITLE,"TS resume experiment").putExtra(PlayerActivity.EXTRA_ITEM_TYPE,"movie"));
   activity=ins.waitForMonitorWithTimeout(monitor,20000); assertNotNull("PlayerActivity did not finish cold creation",activity);
   java.lang.reflect.Field field=PlayerActivity.class.getDeclaredField("player");field.setAccessible(true);
   ExoPlayer p=(ExoPlayer)field.get(activity);ref.set(p);assertNotNull(p);
   ins.runOnMainSync(()->{
    p.stop();
    p.setVideoFrameMetadataListener((pts,release,format,mediaFormat)->{
     int c=count.getAndIncrement();
     if(c==0){m[0]=SystemClock.elapsedRealtime()-started[0];m[1]=pts;}
     if(c==1){m[2]=SystemClock.elapsedRealtime()-started[0];m[3]=pts;frames.countDown();}
    });
    p.addListener(new Player.Listener(){
     @Override public void onRenderedFirstFrame(){m[4]=p.getCurrentPosition();}
     @Override public void onPlayerError(PlaybackException e){error.set(e);frames.countDown();}
    });
    ExtractorsFactory baseline=()->new Extractor[]{new TsExtractor()};
    ExtractorsFactory factory=preroll?new tv.norva.playback.TsResumeExtractorsFactory(baseline):baseline;
    ProgressiveMediaSource source=new ProgressiveMediaSource.Factory(()->new MeteredSource(bytes,rate,delivered),factory)
     .createMediaSource(MediaItem.fromUri("https://fixture.invalid/long-gop.ts"));
    started[0]=SystemClock.elapsedRealtime();p.setMediaSource(source,resume);p.prepare();p.play();
   });
   assertTrue("No second frame",frames.await(35,TimeUnit.SECONDS));assertNull(error.get());
   ins.runOnMainSync(()->{});
   Log.i("NorvaTsPreroll","fixture="+fixture+" rate="+rate+" bytes="+delivered.get()+" resume="+resume+" preroll="+preroll+" firstMs="+m[0]+" secondMs="+m[2]+" firstPts="+m[1]+" secondPts="+m[3]+" positionMs="+m[4]);
   assertTrue("Actual first rendered callback missing",m[4]>=0);
   assertTrue("Requested timeline position lost",Math.abs(m[4]-resume)<750);
   if(preroll)assertTrue("Pre-roll still waits for a future keyframe",m[2]-m[0]<1000);
  } finally {
   final Activity a=activity;
   ins.runOnMainSync(()->{if(ref.get()!=null)ref.get().stop();if(a!=null)a.finish();});
   ins.removeMonitor(monitor);
  }
 }
 private static final class MeteredSource implements androidx.media3.datasource.DataSource {
  private final ByteArrayDataSource delegate;
  private final int rate;private final AtomicLong total;
  private long opened,bytes;
  MeteredSource(byte[] data,int rate,AtomicLong total){delegate=new ByteArrayDataSource(data);this.rate=rate;this.total=total;}
  public void addTransferListener(androidx.media3.datasource.TransferListener l){delegate.addTransferListener(l);}
  public long open(androidx.media3.datasource.DataSpec s)throws IOException {
   if(rate>0)SystemClock.sleep(100);
   opened=SystemClock.elapsedRealtime();bytes=0;return delegate.open(s);
  }
  public int read(byte[] b,int offset,int length)throws IOException {
   int n=delegate.read(b,offset,Math.min(length,4096));
   if(n>0){bytes+=n;total.addAndGet(n);if(rate>0){long delay=opened+(bytes*1000+rate-1)/rate-SystemClock.elapsedRealtime();if(delay>0)SystemClock.sleep(delay);}}
   return n;
  }
  public android.net.Uri getUri(){return delegate.getUri();}
  public void close()throws IOException{delegate.close();}
 }
}

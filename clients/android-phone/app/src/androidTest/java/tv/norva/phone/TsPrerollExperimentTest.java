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
  byte[] bytes;
  try(InputStream in=ins.getContext().getAssets().open("long-gop.ts"); ByteArrayOutputStream out=new ByteArrayOutputStream()) {
   byte[] b=new byte[8192]; int n; while((n=in.read(b))!=-1)out.write(b,0,n); bytes=out.toByteArray();
  }
  File f=new File(ins.getTargetContext().getCacheDir(),"long-gop.ts");
  try(FileOutputStream out=new FileOutputStream(f)){out.write(bytes);}
  try {
   for(long resume:new long[]{5000,17000,25000}) {
    for(boolean preroll:new boolean[]{false,true}) run(ins,bytes,f,resume,preroll);
   }
  } finally { f.delete(); }
 }
 private void run(Instrumentation ins,byte[] bytes,File file,long resume,boolean preroll) throws Exception {
  Instrumentation.ActivityMonitor monitor=ins.addMonitor(PlayerActivity.class.getName(),null,false);
  Activity activity=null; AtomicReference<ExoPlayer> ref=new AtomicReference<>();
  AtomicReference<PlaybackException> error=new AtomicReference<>();
  CountDownLatch frames=new CountDownLatch(1); long[] m={-1,-1,-1,-1,-1};
  AtomicInteger count=new AtomicInteger(); long[] started={0};
  try {
   ins.getTargetContext().startActivity(new Intent(ins.getTargetContext(),PlayerActivity.class)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(PlayerActivity.EXTRA_URL,file.toURI().toString())
    .putExtra(PlayerActivity.EXTRA_TITLE,"TS resume experiment").putExtra(PlayerActivity.EXTRA_ITEM_TYPE,"movie"));
   activity=ins.waitForMonitorWithTimeout(monitor,5000); assertNotNull(activity);
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
    ExtractorsFactory factory=()->new Extractor[]{preroll?new PreRoll(new TsExtractor()):new TsExtractor()};
    ProgressiveMediaSource source=new ProgressiveMediaSource.Factory(()->new ByteArrayDataSource(bytes),factory)
     .createMediaSource(MediaItem.fromUri("https://fixture.invalid/long-gop.ts"));
    started[0]=SystemClock.elapsedRealtime();p.setMediaSource(source,resume);p.prepare();p.play();
   });
   assertTrue("No second frame",frames.await(35,TimeUnit.SECONDS));assertNull(error.get());
   ins.runOnMainSync(()->{});
   Log.i("NorvaTsPreroll","resume="+resume+" preroll="+preroll+" firstMs="+m[0]+" secondMs="+m[2]+" firstPts="+m[1]+" secondPts="+m[3]+" positionMs="+m[4]);
   assertTrue("Actual first rendered callback missing",m[4]>=0);
   assertTrue("Requested timeline position lost",Math.abs(m[4]-resume)<750);
   if(preroll)assertTrue("Pre-roll still waits for a future keyframe",m[2]-m[0]<1000);
  } finally {
   final Activity a=activity;
   ins.runOnMainSync(()->{if(ref.get()!=null)ref.get().stop();if(a!=null)a.finish();});
   ins.removeMonitor(monitor);
  }
 }
 /** Keep sample-queue target unchanged; move only extractor decoding start earlier. */
 private static final class PreRoll implements Extractor {
  private final Extractor delegate; private boolean rewind;
  PreRoll(Extractor d){delegate=d;}
  public boolean sniff(ExtractorInput i)throws IOException{return delegate.sniff(i);}
  public void init(ExtractorOutput o){delegate.init(o);}
  public void seek(long position,long timeUs){long t=Math.max(0,timeUs-15000000L);rewind=t==0;delegate.seek(rewind?0:position,t);}
  public int read(ExtractorInput i,PositionHolder h)throws IOException{
   if(rewind){if(i.getPosition()!=0){h.position=0;return RESULT_SEEK;}rewind=false;}
   return delegate.read(i,h);
  }
  public void release(){delegate.release();}
 }
}
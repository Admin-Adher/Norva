package tv.norva.phone;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.*;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.Assert.*;

/** Opt-in real catalogue replay. The loopback bridge authenticates the current
 * isolated Edge/Gateway; no supplier credential or paid R2 bucket enters the APK.
 * This runner must execute alone: one supplier connection, sequential sessions. */
@RunWith(AndroidJUnit4.class)
public final class RealCatalogueCacheInstrumentedTest {
 private String base;
 private static boolean routed;
 private final Instrumentation ins=InstrumentationRegistry.getInstrumentation();
 @Before public void configure() throws Exception {
  base=InstrumentationRegistry.getArguments().getString("norvaRealVodBase");
  Assume.assumeTrue("Real catalogue replay requires an explicitly supplied local bridge",base!=null);
  URL u=new URL(base);assertTrue("Only the emulator host bridge is allowed",u.getProtocol().equals("http") && u.getHost().equals("10.0.2.2") && u.getPort()==19628 && u.getPath().isEmpty());
  // Test-only routing of the native heartbeat/event endpoint. Its request body
  // is unchanged; the bridge supplies the real isolated Edge authentication.
  if(!routed)URL.setURLStreamHandlerFactory(protocol->!protocol.equals("https")?null:new URLStreamHandler(){
   @Override protected URLConnection openConnection(URL target)throws IOException {
    if(!target.getHost().equals("api.norva.tv"))throw new IOException("Unexpected test endpoint");
    return new URL(base+target.getFile()).openConnection();
   }
  });
  routed=true;
 }
 @Test public void mp4ResumeSeekAndContinue()throws Exception { replay(6); }
 @Test public void mkvResumeSeekAndContinue()throws Exception { replay(5); }
 @Test public void tsResumeSeekAndContinue()throws Exception { replay(9); }
 @Test public void episodeResumeSeekAndContinue()throws Exception { replay(10); }
 private JSONObject post(String p,JSONObject body)throws Exception {
  HttpURLConnection c=(HttpURLConnection)new URL(base+p).openConnection();c.setConnectTimeout(10000);c.setReadTimeout(130000);c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");byte[] b=body.toString().getBytes(StandardCharsets.UTF_8);c.setFixedLengthStreamingMode(b.length);
  try(OutputStream out=c.getOutputStream()){out.write(b);}int status=c.getResponseCode();assertTrue("Local replay request status "+status,status>=200 && status<300);
  try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){assertTrue(out.size()+n<1000000);out.write(buffer,0,n);}return new JSONObject(out.toString("UTF-8"));}finally{c.disconnect();}
 }
 private void replay(int ordinal)throws Exception {
  double position=0;
  for(int attempt=0;attempt<2;attempt++) {
   long began=SystemClock.elapsedRealtime();JSONObject session=post("/start",new JSONObject().put("ordinal",ordinal).put("surface","android").put("position",position));
   String sid=session.getString("sid"),token=UUID.randomUUID().toString(),channel=UUID.randomUUID().toString();Context ctx=ins.getTargetContext();CountDownLatch frame=new CountDownLatch(1);AtomicReference<Intent> frameResult=new AtomicReference<>();
   BroadcastReceiver frames=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){if(token.equals(i.getStringExtra(PlayerActivity.EXTRA_FIRST_FRAME_TEST_TOKEN))){frameResult.set(i);frame.countDown();}}};
   BroadcastReceiver auth=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){if(channel.equals(i.getStringExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_CHANNEL_ID)))ctx.sendBroadcast(new Intent(PlayerActivity.ACTION_APPLY_PLAYBACK_AUTH).setPackage(ctx.getPackageName()).putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_CHANNEL_ID,channel).putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_REQUEST_NONCE,i.getStringExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_REQUEST_NONCE)).putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_TOKEN,"isolated-real-catalogue-native-cache"));}};
   ContextCompat.registerReceiver(ctx,frames,new IntentFilter(PlayerActivity.ACTION_FIRST_FRAME_TEST_RESULT),ContextCompat.RECEIVER_NOT_EXPORTED);ContextCompat.registerReceiver(ctx,auth,new IntentFilter(PlayerActivity.ACTION_REQUEST_PLAYBACK_AUTH),ContextCompat.RECEIVER_NOT_EXPORTED);
   Instrumentation.ActivityMonitor monitor=ins.addMonitor(PlayerActivity.class.getName(),null,false);Activity activity=null;JSONObject proof=new JSONObject().put("surface","android").put("title",session.getString("title")).put("attempt",attempt+1);
   try {
    ctx.startActivity(new Intent(ctx,PlayerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(PlayerActivity.EXTRA_URL,session.getString("url")).putExtra(PlayerActivity.EXTRA_TITLE,session.getString("title")).putExtra(PlayerActivity.EXTRA_CONTAINER,session.getString("container")).putExtra(PlayerActivity.EXTRA_SOURCE_ID,session.getString("sourceId")).putExtra(PlayerActivity.EXTRA_ITEM_TYPE,session.getString("itemType")).putExtra(PlayerActivity.EXTRA_ITEM_ID,session.getString("itemId")).putExtra(PlayerActivity.EXTRA_PLAYBACK_SESSION_ID,sid).putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_CHANNEL_ID,channel).putExtra(PlayerActivity.EXTRA_PLAYBACK_AUTH_TOKEN,"isolated-real-catalogue-native-cache").putExtra(PlayerActivity.EXTRA_RESUME_SECONDS,(int)Math.floor(position)).putExtra(PlayerActivity.EXTRA_FIRST_FRAME_TEST_TOKEN,token));
    activity=ins.waitForMonitorWithTimeout(monitor,20000);assertNotNull("Native Activity did not open",activity);assertTrue("No native first-frame result",frame.await(100,TimeUnit.SECONDS));assertEquals("Rendered native frame required","first_frame",frameResult.get().getStringExtra(PlayerActivity.EXTRA_FIRST_FRAME_TEST_OUTCOME));
    proof.put("firstFrameSeconds",(SystemClock.elapsedRealtime()-began)/1000d).put("videoMime",frameResult.get().getStringExtra(PlayerActivity.EXTRA_FIRST_FRAME_TEST_VIDEO_MIME)).put("audioMime",frameResult.get().getStringExtra(PlayerActivity.EXTRA_FIRST_FRAME_TEST_AUDIO_MIME));
    final PlayerActivity a=(PlayerActivity)activity;AtomicReference<ExoPlayer> ref=new AtomicReference<>();ins.runOnMainSync(()->ref.set((ExoPlayer)((PlayerView)a.findViewById(R.id.norva_player_view)).getPlayer()));ExoPlayer player=ref.get();assertNotNull(player);
    JSONArray trace=new JSONArray();observe(a,player,attempt==0?30000:12000,trace);
    if(attempt==1){
     seek(player,-8,trace);seek(player,120,trace);
     AtomicLong continuationStart=new AtomicLong();ins.runOnMainSync(()->continuationStart.set(player.getCurrentPosition()));
     observe(a,player,150000,trace);
     AtomicLong continuationEnd=new AtomicLong();ins.runOnMainSync(()->continuationEnd.set(player.getCurrentPosition()));
     assertTrue("Native continuation must advance beyond the cached window",continuationEnd.get()-continuationStart.get()>=120000);
    }
    AtomicLong rendered=new AtomicLong(-1);ins.runOnMainSync(()->rendered.set(a.nativeResumePositionMs()));assertTrue("Decoded resume clock unavailable",rendered.get()>=0);position=rendered.get()/1000d;
    proof.put("position",position).put("trace",trace);post("/proof",proof);
    ins.runOnMainSync(a::onBackPressed);ins.waitForIdleSync();activity=null;
    post("/playback/sessions/"+sid+"/expire",new JSONObject().put("resumePosition",position));SystemClock.sleep(1000);
   } finally {
    if(activity!=null){final Activity a=activity;ins.runOnMainSync(a::finish);try{post("/playback/sessions/"+sid+"/expire",new JSONObject());}catch(Throwable ignored){}}
    ins.removeMonitor(monitor);ctx.unregisterReceiver(frames);ctx.unregisterReceiver(auth);
   }
  }
 }
 private void observe(PlayerActivity a,ExoPlayer p,long duration,JSONArray trace)throws Exception {
  long end=SystemClock.elapsedRealtime()+duration;
  while(SystemClock.elapsedRealtime()<end){AtomicReference<JSONObject> row=new AtomicReference<>();ins.runOnMainSync(()->{try{JSONObject r=new JSONObject().put("elapsedMs",SystemClock.elapsedRealtime()).put("position",p.getCurrentPosition()/1000d).put("state",p.getPlaybackState()).put("playing",p.isPlaying());if(p.getPlayerError()!=null)r.put("errorCode",p.getPlayerError().errorCode);if(p.getVideoDecoderCounters()!=null)r.put("renderedFrames",p.getVideoDecoderCounters().renderedOutputBufferCount).put("droppedFrames",p.getVideoDecoderCounters().droppedBufferCount);row.set(r);}catch(Exception e){throw new RuntimeException(e);}});JSONObject r=row.get();trace.put(r);assertFalse("Native playback decoder/network error",r.has("errorCode"));SystemClock.sleep(1000);}
 }
 private void seek(ExoPlayer p,long delta,JSONArray trace)throws Exception {
  AtomicLong target=new AtomicLong();long began=SystemClock.elapsedRealtime();ins.runOnMainSync(()->{target.set(Math.max(0,p.getCurrentPosition()+delta*1000));p.seekTo(target.get());});
  AtomicBoolean ready=new AtomicBoolean();while(SystemClock.elapsedRealtime()-began<60000){ins.runOnMainSync(()->ready.set(p.getPlaybackState()==Player.STATE_READY && p.isPlaying() && Math.abs(p.getCurrentPosition()-target.get())<3000));if(ready.get())break;SystemClock.sleep(50);}
  trace.put(new JSONObject().put("seekTarget",target.get()/1000d).put("seekSeconds",(SystemClock.elapsedRealtime()-began)/1000d).put("ready",ready.get()));assertTrue("Native seek did not resume",ready.get());
 }
}

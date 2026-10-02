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
        try {
            target.startActivity(new Intent().setClassName(target,activityName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra("url",fixture.toURI().toString()).putExtra("title","Norva legacy XVID QA")
                    .putExtra("local",true).putExtra("itemType","movie").putExtra("resumeSeconds",3));
            activity=ins.waitForMonitorWithTimeout(monitor,10000);
            assertNotNull(activity);final Activity opened=activity;
            java.lang.reflect.Field field=activity.getClass().getDeclaredField("player");field.setAccessible(true);
            ExoPlayer[] holder=new ExoPlayer[1];ins.runOnMainSync(()->{try{holder[0]=(ExoPlayer)field.get(opened);}catch(Exception e){throw new AssertionError(e);}});
            ExoPlayer player=holder[0];assertNotNull(player);
            long[] observed={0,0,0};boolean[] selected={false};long start=SystemClock.elapsedRealtime();
            while(SystemClock.elapsedRealtime()-start<20000) {
                ins.runOnMainSync(()->{
                    assertNull(player.getPlayerError());
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
}

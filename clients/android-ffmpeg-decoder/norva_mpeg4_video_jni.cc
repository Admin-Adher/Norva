// Norva MPEG-4 Part 2 adapter, compiled into the existing LGPL FFmpeg JNI library.
// No demuxer, network client or transcoder: packets come only from Media3.
#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <cstring>
#include <new>

#define NORVA_MPEG4(ret, name, ...) extern "C" JNIEXPORT ret JNICALL \
 Java_tv_norva_playback_Mpeg4VideoDecoder_##name(JNIEnv* env, jclass, ##__VA_ARGS__)

namespace {
struct NorvaMpeg4Context {
  AVCodecContext* codec = nullptr;
  AVFrame* frame = nullptr;
  ~NorvaMpeg4Context() { av_frame_free(&frame); avcodec_free_context(&codec); }
};
NorvaMpeg4Context* norvaContext(jlong value) { return reinterpret_cast<NorvaMpeg4Context*>(value); }
bool norvaDimensions(int width, int height) {
  return width > 0 && height > 0 && width <= 4096 && height <= 4096;
}
void norvaPlane(uint8_t* out, int outStride, const uint8_t* in, int inStride, int width, int height) {
  for (int y = 0; y < height; y++) { std::memcpy(out, in, width); out += outStride; in += inStride; }
}
}

NORVA_MPEG4(jint, nativeVersion) { return avcodec_find_decoder(AV_CODEC_ID_MPEG4) ? 1 : 0; }
NORVA_MPEG4(jlong, nativeCreate, jbyteArray extra, jint width, jint height) {
  const AVCodec* codec = avcodec_find_decoder(AV_CODEC_ID_MPEG4);
  if (!codec || width < 0 || height < 0 || width > 4096 || height > 4096) return 0;
  auto* state = new(std::nothrow) NorvaMpeg4Context();
  if (!state) return 0;
  state->codec = avcodec_alloc_context3(codec);
  state->frame = av_frame_alloc();
  if (!state->codec || !state->frame) { delete state; return 0; }
  state->codec->width = width; state->codec->height = height;
  state->codec->max_pixels = 4096LL * 4096;
  state->codec->pkt_timebase = AVRational{1, 1000000};
  state->codec->thread_count = 2;
  state->codec->thread_type = FF_THREAD_SLICE;
  if (extra) {
    const int size = env->GetArrayLength(extra);
    if (size < 0 || size > 65536) { delete state; return 0; }
    state->codec->extradata = static_cast<uint8_t*>(av_mallocz(size + AV_INPUT_BUFFER_PADDING_SIZE));
    if (!state->codec->extradata) { delete state; return 0; }
    state->codec->extradata_size = size;
    env->GetByteArrayRegion(extra, 0, size, reinterpret_cast<jbyte*>(state->codec->extradata));
    if (env->ExceptionCheck()) { delete state; return 0; }
  }
  if (avcodec_open2(state->codec, codec, nullptr) < 0) { delete state; return 0; }
  return reinterpret_cast<jlong>(state);
}
NORVA_MPEG4(jint, nativeSend, jlong value, jobject data, jint offset, jint size, jlong pts, jboolean eos) {
  auto* state = norvaContext(value);
  if (!state) return -1;
  AVPacket* packet = nullptr;
  if (!eos) {
    const auto capacity = data ? env->GetDirectBufferCapacity(data) : -1;
    if (offset < 0 || size <= 0 || size > 16 * 1024 * 1024 || capacity < static_cast<int64_t>(offset) + size) return -2;
    auto* bytes = static_cast<uint8_t*>(env->GetDirectBufferAddress(data));
    packet = av_packet_alloc();
    if (!bytes || !packet || av_new_packet(packet, size) < 0) { av_packet_free(&packet); return -3; }
    // av_new_packet pads the bitstream and owns its memory across FFmpeg delay.
    std::memcpy(packet->data, bytes + offset, size);
    packet->pts = pts; packet->dts = AV_NOPTS_VALUE;
  }
  int result = avcodec_send_packet(state->codec, packet);
  av_packet_free(&packet);
  return result == AVERROR(EAGAIN) ? 0 : result < 0 ? result : 1;
}
NORVA_MPEG4(jint, nativeReceive, jlong value, jlongArray info) {
  auto* state = norvaContext(value);
  if (!state || !info || env->GetArrayLength(info) < 5) return -1;
  av_frame_unref(state->frame);
  int result = avcodec_receive_frame(state->codec, state->frame);
  if (result == AVERROR(EAGAIN)) return 0;
  if (result == AVERROR_EOF) return 2;
  if (result < 0) return result;
  const AVFrame* frame = state->frame;
  if (!norvaDimensions(frame->width, frame->height) || frame->format != AV_PIX_FMT_YUV420P
      || !frame->data[0] || !frame->data[1] || !frame->data[2]
      || frame->best_effort_timestamp == AV_NOPTS_VALUE) return -4;
  jlong fields[5] = {frame->width, frame->height, frame->best_effort_timestamp,
      frame->colorspace == AVCOL_SPC_BT709 ? 2 : frame->colorspace == AVCOL_SPC_BT2020_NCL ? 3 : 1, 0};
  env->SetLongArrayRegion(info, 0, 5, fields);
  return env->ExceptionCheck() ? -5 : 1;
}
NORVA_MPEG4(jboolean, nativeCopy, jlong value, jobject output) {
  auto* state = norvaContext(value);
  if (!state || !output) return false;
  const AVFrame* frame = state->frame;
  int w = frame->width, h = frame->height, cw = (w + 1) / 2, ch = (h + 1) / 2;
  if (!norvaDimensions(w, h) || frame->format != AV_PIX_FMT_YUV420P
      || env->GetDirectBufferCapacity(output) < static_cast<int64_t>(w)*h + 2LL*cw*ch) return false;
  auto* bytes = static_cast<uint8_t*>(env->GetDirectBufferAddress(output));
  if (!bytes) return false;
  norvaPlane(bytes, w, frame->data[0], frame->linesize[0], w, h);
  norvaPlane(bytes + w*h, cw, frame->data[1], frame->linesize[1], cw, ch);
  norvaPlane(bytes + w*h + cw*ch, cw, frame->data[2], frame->linesize[2], cw, ch);
  return true;
}
NORVA_MPEG4(jboolean, nativeRender, jobject output, jint w, jint h, jobject surface) {
  if (!output || !surface || !norvaDimensions(w, h)) return false;
  int cw = (w + 1) / 2, ch = (h + 1) / 2;
  if (env->GetDirectBufferCapacity(output) < static_cast<int64_t>(w)*h + 2LL*cw*ch) return false;
  auto* bytes = static_cast<uint8_t*>(env->GetDirectBufferAddress(output));
  ANativeWindow* window = ANativeWindow_fromSurface(env, surface);
  if (!bytes || !window) { if (window) ANativeWindow_release(window); return false; }
  constexpr int yv12 = 0x32315659;
  ANativeWindow_Buffer buffer{};
  bool ok = ANativeWindow_setBuffersGeometry(window, w, h, yv12) == 0;
  if (ok) {
    ok = ANativeWindow_lock(window, &buffer, nullptr) == 0;
    if (ok) {
      int uvStride = ((buffer.stride + 1) / 2 + 15) & ~15;
      int uvHeight = (buffer.height + 1) / 2;
      ok = buffer.bits && buffer.format == yv12 && buffer.width >= w && buffer.height >= h
          && buffer.stride >= w && uvStride >= cw;
      if (ok) {
        auto* dst = static_cast<uint8_t*>(buffer.bits);
        norvaPlane(dst, buffer.stride, bytes, w, w, h);
        // Android YV12 stores V before U; input planes are Y, U, V.
        norvaPlane(dst + buffer.stride*buffer.height, uvStride, bytes + w*h + cw*ch, cw, cw, ch);
        norvaPlane(dst + buffer.stride*buffer.height + uvStride*uvHeight, uvStride, bytes + w*h, cw, cw, ch);
      }
      ok = ANativeWindow_unlockAndPost(window) == 0 && ok;
    }
  }
  ANativeWindow_release(window);
  return ok;
}
NORVA_MPEG4(void, nativeFlush, jlong value) {
  auto* state = norvaContext(value);
  if (state) { avcodec_flush_buffers(state->codec); av_frame_unref(state->frame); }
}
NORVA_MPEG4(void, nativeRelease, jlong value) { delete norvaContext(value); }

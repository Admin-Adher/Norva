# Candidate overlay only. BASE_IMAGE must be the inspected immutable live image ID.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chmod=0644 services/media-gateway/src/index.js services/media-gateway/src/private-resume-hls-cache.js services/media-gateway/src/private-resume-profile.js services/media-gateway/src/private-resume-subtitles.js services/media-gateway/src/maintenance-fence.js services/media-gateway/src/maintenance-http.js /app/src/

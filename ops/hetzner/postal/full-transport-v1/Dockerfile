FROM norva-postal-branded-reviewed-base:20260906
WORKDIR /app
COPY service.mjs gateway.mjs model.mjs store.mjs worker.mjs postal-mail-wire.mjs postal-webhook-verifier.mjs ./
CMD ["node","/app/service.mjs"]

# Private, fixed Rails runner. Its controller never forwards commands or paths.
require 'json'
require 'net/http'
require 'openssl'
require 'base64'
require 'digest'
begin
 input=JSON.parse(STDIN.read(390001));mode=input.fetch('mode');server=Server.find(1);credential=server.credentials.sole
 raise 'wrong_runtime' unless File.exist?('/config/candidate-manifest.json') && Server.count==1 &&
   Postal::Config.main_db.database=='postalmain' && server.mode=='Development' && !server.suspended? &&
   credential.type=='API' && credential.hold && Route.count.zero? && !Postal::Config.logging.enabled?
 case mode
 when 'health'
  public_key=OpenSSL::PKey.read(File.read('/config/signing.key')).public_key
  public_jwk={kty:'RSA',n:Base64.urlsafe_encode64(public_key.n.to_s(2),padding:false),
   e:Base64.urlsafe_encode64(public_key.e.to_s(2),padding:false),kid:Postal.signer.jwk.kid}
  puts JSON.generate(ok:true,heldCredential:true,development:true,messages:server.message_db.messages(count:true),
   queued:QueuedMessage.count,callbacks:WebhookRequest.count,publicJwk:public_jwk)
 when 'find'
  tag=input.fetch('tag');recipient=input.fetch('recipient')
  raise 'invalid_tag' unless tag.match?(/\Anorva-mail-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z/)
  matches=server.message_db.messages(where:{tag:tag},limit:2)
  raise 'multiple_receipts' if matches.length>1
  m=matches.first
  if m && m.rcpt_to==recipient && !m.held && QueuedMessage.where(server_id:1,message_id:m.id).count==1
   queued=QueuedMessage.where(server_id:1,message_id:m.id).sole
   raise 'manual_forbidden' if queued.manual?
   holder=Class.new(MessageDequeuer::OutgoingMessageProcessor) do
    private
    def send_message_to_sender;raise 'smtp_forbidden';end
   end
   credential.with_lock do
    raise 'not_held' unless credential.reload.hold
    holder.process(queued,logger:Postal.logger)
   end
   m=server.message_db.message(m.id)
  end
  if m && m.rcpt_to==recipient && m.held && QueuedMessage.where(server_id:1,message_id:m.id).count.zero?
   puts JSON.generate(held:true,messageId:m.id,provider:'postal')
  else;puts JSON.generate(held:false,uncertain:true);end
 when 'hold'
  m=input.fetch('message');tag=m.fetch('tag');recipient=m.fetch('to')
  raise 'bad_message' unless tag.match?(/\Anorva-mail-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z/) &&
   m.fetch('from')=='Norva <support@notify.norva.tv>'
  raise 'suppressed' if server.message_db.suppression_list.get(:recipient,recipient)
  raise 'already_present' if server.message_db.messages(where:{tag:tag},limit:1).any?
  payload={to:[recipient],from:m['from'],subject:m.fetch('subject'),plain_body:m.fetch('text'),html_body:m.fetch('html'),
   tag:tag,headers:m.fetch('headers',{}).merge({'Reply-To'=>m['reply_to'],'X-Norva-Mail-Delivery'=>tag})}
  http=Net::HTTP.new('postal.norva.tv',5443,nil);http.ipaddr='127.0.0.1';http.use_ssl=true
  http.verify_mode=OpenSSL::SSL::VERIFY_PEER;http.min_version=OpenSSL::SSL::TLS1_2_VERSION
  http.open_timeout=4;http.read_timeout=5;http.write_timeout=5;http.max_retries=0
  req=Net::HTTP::Post.new('/api/v1/send/message');req['Content-Type']='application/json';req['X-Server-API-Key']=credential.key
  req.body=JSON.generate(payload);res=http.start{|c|c.request(req)};result=JSON.parse(res.body)
  raise 'not_accepted' unless res.code=='200' && result['status']=='success'
  id=result.fetch('data').fetch('messages').fetch(recipient).fetch('id');message=server.message_db.message(id)
  raise 'binding' unless message && message.tag==tag && message.rcpt_to==recipient && message.credential.id==credential.id
  raise 'unexpected_queue' unless QueuedMessage.where(server_id:1,message_id:id).count==1
  queued=QueuedMessage.where(server_id:1,message_id:id).sole;raise 'manual_forbidden' if queued.manual?
  holder=Class.new(MessageDequeuer::OutgoingMessageProcessor) do
   private
   def send_message_to_sender;raise 'smtp_forbidden';end
  end
  credential.with_lock do
   raise 'not_held' unless credential.reload.hold
   holder.process(queued,logger:Postal.logger)
  end
  message=server.message_db.message(id)
  raise 'not_held' unless message.held && QueuedMessage.where(server_id:1,message_id:id).count.zero?
  puts JSON.generate(provider:'postal',state:'accepted',messageId:id,held:true)
 when 'mime','result'
  id=input.fetch('messageId');tag=input.fetch('tag');recipient=input.fetch('recipient')
  raise 'bad_id' unless id.is_a?(Integer) && tag.match?(/\Anorva-mail-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z/)
  m=server.message_db.message(id)
  raise 'binding' unless m && m.scope=='outgoing' && m.tag==tag && m.rcpt_to==recipient && m.held && m.credential.id==credential.id &&
   QueuedMessage.where(server_id:1,message_id:id).count.zero?
  raise 'suppressed' if server.message_db.suppression_list.get(:recipient,recipient)
  if mode=='mime'
   m.parse_content if m.should_parse?;m.add_outgoing_headers unless m.has_outgoing_headers?
   raise 'mime_invalid' unless m.raw_message.bytesize.between?(1,262144) && m.raw_message.include?('DKIM-Signature:')
   puts JSON.generate(raw:Base64.strict_encode64(m.raw_message),returnPath:"#{server.token}@#{Postal::Config.dns.return_path_domain}",recipient:m.rcpt_to)
  else
   status=input.fetch('status');raise 'bad_status' unless %w[Sent HardFail Held].include?(status)
   m.create_delivery(status,details:'Private controlled branded queue; no automatic SMTP replay.',
    output:'Bound durable SMTP receipt. Inbox placement requires mailbox verification.',sent_with_ssl:input.fetch('secure')==true)
   puts JSON.generate(ok:true)
  end
 when 'feedback'
  # Receive-only work continues after the sending window has expired. Process
  # only a DSN correlated to one of this controlled pair's original messages.
  before_messages=server.message_db.messages(count:true)
  incoming=QueuedMessage.where(server_id:1).limit(32).to_a.select{|q|q.message.scope=='incoming' && q.message.bounce}
  incoming.each do |queued|
   original=queued.message.original_messages
   next unless original.length==1 && original.first.scope=='outgoing' &&
    original.first.tag.to_s.match?(/\Anorva-mail-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z/)
   receiver=Class.new(MessageDequeuer::IncomingMessageProcessor) do
    private
    def send_message_to_sender;raise 'outgoing_from_dsn_forbidden';end
    def bounce_messages;raise 'outgoing_from_dsn_forbidden';end
    def send_bounce_on_hard_fail;raise 'outgoing_from_dsn_forbidden';end
   end
   receiver.process(queued,logger:Postal.logger)
  end
  raise 'dsn_created_extra_message' unless server.message_db.messages(count:true)==before_messages
  signing=OpenSSL::PKey.read(File.read('/config/signing.key'))
  result=server.webhook_requests.order(:id).limit(200).filter_map do |req|
   bound=req.payload[:original_message] || req.payload[:message]
   next unless bound && bound[:tag].to_s.match?(/\Anorva-mail-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z/) && bound[:direction]=='outgoing'
   body=JSON.generate(event:req.event,timestamp:req.created_at.to_f,payload:req.payload,uuid:req.uuid)
   {requestId:req.id,tag:bound[:tag],body:body,signature:Base64.strict_encode64(signing.sign('SHA256',body))}
  end
  result=result.first(16)
  puts JSON.generate(events:result)
 when 'ack'
  req=server.webhook_requests.find(Integer(input.fetch('requestId')));bound=req.payload[:original_message] || req.payload[:message]
  raise 'ack_binding' unless bound && bound[:tag]==input.fetch('tag') && bound[:tag].match?(/\Anorva-mail-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z/)
  req.destroy!;puts JSON.generate(ok:true)
 else;raise 'invalid_mode'
 end
rescue StandardError
 puts JSON.generate(ok:false,error:'private_postal_operation_refused',detailsSuppressed:true);exit 1
end

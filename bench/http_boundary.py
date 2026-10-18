"""Never forward fixture authorization through an untrusted redirect."""
import urllib.parse
import urllib.request
import uuid
import ssl
import threading

_LEDGER_TLS_CONTEXT = None
_LEDGER_TLS_LOCK = threading.Lock()


def _ledger_tls_context():
    global _LEDGER_TLS_CONTEXT
    with _LEDGER_TLS_LOCK:
        if _LEDGER_TLS_CONTEXT is None:
            context = ssl.create_default_context()
            context.set_alpn_protocols(['http/1.1'])
            if getattr(context, 'post_handshake_auth', None) is not None:
                context.post_handshake_auth = True
            if context.verify_mode != ssl.CERT_REQUIRED or context.check_hostname is not True:
                raise RuntimeError('Fixture TLS verification must remain enabled')
            _LEDGER_TLS_CONTEXT = context
        context = _LEDGER_TLS_CONTEXT
    if context.verify_mode != ssl.CERT_REQUIRED or context.check_hostname is not True:
        raise RuntimeError('Fixture TLS verification must remain enabled')
    return context


class FixtureRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections=1
    max_repeats=1

    def __init__(self,s3_endpoint=None):
        self.endpoint=None
        if s3_endpoint is not None:
            endpoint=urllib.parse.urlsplit(s3_endpoint)
            if endpoint.scheme not in ('http','https') or endpoint.hostname not in ('127.0.0.1','localhost') or endpoint.username is not None or endpoint.password is not None or endpoint.path not in ('','/') or endpoint.query or endpoint.fragment:
                raise ValueError('Invalid owned S3 redirect endpoint')
            self.endpoint=endpoint

    def redirect_request(self,request,fp,code,msg,headers,newurl):
        if self.endpoint is None:
            return None
        target=urllib.parse.urlsplit(newurl)
        if code!=302 or request.get_method()!='GET' or (target.scheme,target.hostname,target.port)!=(self.endpoint.scheme,self.endpoint.hostname,self.endpoint.port) or target.username is not None or target.password is not None or target.fragment:
            raise RuntimeError('Redirect crossed its owned fixture boundary')
        parts=target.path.split('/')
        try:
            valid=len(parts)==4 and parts[:3]==['','benchmark-files','bench'] and str(uuid.UUID(parts[3]))==parts[3]
        except ValueError:
            valid=False
        query=urllib.parse.parse_qs(target.query)
        if not valid or query.get('X-Amz-Algorithm')!=['AWS4-HMAC-SHA256'] or len(query.get('X-Amz-Signature',[]))!=1:
            raise RuntimeError('Redirect is not an owned presigned object read')
        forwarded=super().redirect_request(request,fp,code,msg,headers,newurl)
        forwarded.remove_header('Authorization')
        forwarded.remove_header('Cookie')
        return forwarded


def opener(s3_endpoint=None):
    # Fixture traffic is loopback-only, including its real provider. A system
    # proxy must never receive credentials or signed object URLs from this test.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}),FixtureRedirect(s3_endpoint))


def ledger_opener(s3_endpoint=None):
    """Reuse only the verified CA store; keep each request's handlers private.

    Python constructs an HTTPS context even for an HTTP-only opener. Loading
    its CA store for every ledger request can saturate the generator itself.
    Ordinary campaigns keep the original opener and observer behavior.
    """
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), FixtureRedirect(s3_endpoint),
                                       urllib.request.HTTPSHandler(context=_ledger_tls_context()))

"""Owned presigned redirects cannot leak a fixture bearer or cookie."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import os
import secrets
import ssl
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.parse
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'bench'))
from http_boundary import FixtureRedirect
import http_boundary as boundary


class FixtureRedirects(unittest.TestCase):
    def setUp(self):
        self.handler=FixtureRedirect('http://127.0.0.1:9100')
        self.query=urllib.parse.urlencode({'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Signature':secrets.token_hex(32)})
        self.path='/benchmark-files/bench/'+str(uuid.uuid4())
        self.request=urllib.request.Request('http://127.0.0.1:8000/storage/v1/object/bench/fixture.txt',headers={'Authorization':'Bearer '+secrets.token_urlsafe(32),'Cookie':'fixture='+secrets.token_urlsafe(32)})

    def test_owned_presigned_read_drops_application_credentials(self):
        url='http://127.0.0.1:9100'+self.path+'?'+self.query
        forwarded=self.handler.redirect_request(self.request,None,302,'Found',{},url)
        self.assertEqual(forwarded.full_url,url)
        self.assertFalse(forwarded.has_header('Authorization'))
        self.assertFalse(forwarded.has_header('Cookie'))
        self.assertTrue(self.request.has_header('Authorization'))

    def test_external_rebound_or_unsigned_target_is_rejected(self):
        for url in ['https://example.test'+self.path+'?'+self.query,'http://127.0.0.1:9101'+self.path+'?'+self.query,'http://127.0.0.1:9100/admin?'+self.query,'http://127.0.0.1:9100'+self.path,'http://operator@127.0.0.1:9100'+self.path+'?'+self.query]:
            with self.assertRaises(RuntimeError):
                self.handler.redirect_request(self.request,None,302,'Found',{},url)

    def test_ordinary_fixture_request_never_follows_a_redirect(self):
        self.assertIsNone(FixtureRedirect().redirect_request(self.request,None,302,'Found',{},'http://127.0.0.1:9100'+self.path+'?'+self.query))


class LedgerTLSContext(unittest.TestCase):
    def setUp(self):
        self.context_patch = patch.object(boundary, '_LEDGER_TLS_CONTEXT', None)
        self.context_patch.start()
        self.addCleanup(self.context_patch.stop)

    def context(self, opener):
        return next(handler._context for handler in opener.handlers
                    if isinstance(handler, urllib.request.HTTPSHandler))

    def test_fresh_handlers_reuse_one_real_verified_context(self):
        with patch.object(boundary.ssl, 'create_default_context', wraps=ssl.create_default_context) as factory:
            openers = [boundary.ledger_opener() for _ in range(5)]
        factory.assert_called_once_with()
        contexts = [self.context(value) for value in openers]
        self.assertTrue(all(value is contexts[0] for value in contexts))
        self.assertEqual(contexts[0].verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(contexts[0].check_hostname)
        self.assertEqual(len({id(value) for value in openers}), 5)

    def test_concurrent_first_requests_load_the_CA_store_once(self):
        barrier = threading.Barrier(4)
        def construct(_):
            barrier.wait(timeout=3)
            return self.context(boundary.ledger_opener())
        with patch.object(boundary.ssl, 'create_default_context', wraps=ssl.create_default_context) as factory:
            with ThreadPoolExecutor(max_workers=4) as workers:
                contexts = list(workers.map(construct, range(4)))
        factory.assert_called_once_with()
        self.assertTrue(all(value is contexts[0] for value in contexts))

    def test_insecure_verifiers_fail_closed_before_caching_or_reuse(self):
        insecure = SimpleNamespace(check_hostname=False, verify_mode=ssl.CERT_NONE,
                                   post_handshake_auth=None, set_alpn_protocols=Mock())
        with patch.object(boundary.ssl, 'create_default_context', return_value=insecure):
            with self.assertRaises(RuntimeError):
                boundary.ledger_opener()
        self.assertIsNone(boundary._LEDGER_TLS_CONTEXT)
        boundary.ledger_opener()
        boundary._LEDGER_TLS_CONTEXT = insecure
        with self.assertRaises(RuntimeError):
            boundary.ledger_opener()

    def test_redirect_scopes_remain_private_and_environment_proxies_disabled(self):
        with patch.dict(os.environ, {'HTTP_PROXY':'http://untrusted.invalid:8080',
                                     'HTTPS_PROXY':'http://untrusted.invalid:8080'}):
            first = boundary.ledger_opener('http://127.0.0.1:9100')
            second = boundary.ledger_opener('http://127.0.0.1:9200')
        a = next(handler for handler in first.handlers if isinstance(handler, FixtureRedirect))
        b = next(handler for handler in second.handlers if isinstance(handler, FixtureRedirect))
        self.assertIsNot(a, b)
        self.assertEqual((a.endpoint.port, b.endpoint.port), (9100, 9200))
        self.assertFalse(any(getattr(handler, 'proxies', None) for handler in first.handlers+second.handlers))
        self.assertIs(self.context(first), self.context(second))

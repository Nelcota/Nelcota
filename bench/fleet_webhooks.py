"""Signed, bounded webhook evidence for independent project traffic."""
from collections import deque
from pathlib import Path
import time
import uuid

from campaign import Receiver, request
from receiver import EventLedger


class FleetReceiver(Receiver):
    # ReceiverHandler bounds each socket operation to five seconds. Join its
    # request owners before closing their ledger, including on failed campaigns.
    daemon_threads = False


class FleetWebhooks:
    def __init__(self, output):
        self.output = Path(output)
        self.items = []

    def attach(self, project):
        if project.environment.get('NELCOTA_WEBHOOKS_ALLOW_LOOPBACK') != 'true':
            raise RuntimeError('Owned loopback receiver was not declared before project startup')
        receiver = FleetReceiver()
        try:
            ledger = EventLedger(self.output / (project.label + '-events.sqlite'))
        except Exception:
            receiver.close()
            raise
        self.items.append((project, receiver, ledger))
        receiver.requests = ledger
        receiver.errors = deque(maxlen=256)
        hook, _ = request(project.base, '/admin/api/webhooks', {
            'name': 'Owned fleet benchmark', 'table': 'bench_products',
            'url': f'http://127.0.0.1:{receiver.server_address[1]}/',
            'events': ['UPDATE'], 'enabled': True, 'max_attempts': 3,
        }, {'Cookie': project.fixture['cookie'], 'Origin': project.base})
        receiver.secret = hook['secret']
        project.sql("CREATE TABLE public.bench_expected_events(event_id uuid PRIMARY KEY); CREATE FUNCTION public.bench_record_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN INSERT INTO public.bench_expected_events VALUES(NEW.event_id) ON CONFLICT DO NOTHING; RETURN NEW; END $$; REVOKE ALL ON FUNCTION public.bench_record_event() FROM PUBLIC; CREATE TRIGGER bench_record_event AFTER INSERT ON nelcota.webhook_deliveries FOR EACH ROW EXECUTE FUNCTION public.bench_record_event();")

    def observe(self):
        if any(receiver.errors for _, receiver, _ in self.items):
            raise RuntimeError('Fleet webhook signature or receiver invariant failed')
        allocated = sum(path.stat().st_size for path in self.output.glob('project-*-events.sqlite*') if path.is_file())
        if allocated > 128 * 1024 * 1024:
            raise RuntimeError('Fleet webhook evidence exceeded its 128 MiB budget')
        return {'projects': len(self.items), 'signature_errors': 0, 'ledger_bytes': allocated}

    def reconcile(self, deadline_seconds=30):
        if not self.items:
            raise RuntimeError('No fleet webhook receiver was exercised')
        began = time.monotonic()
        while True:
            self.observe()
            pending = {project.label: int(project.sql('SELECT outstanding FROM nelcota.webhook_queue_usage WHERE singleton')) for project, _, _ in self.items}
            if any(value < 0 for value in pending.values()):
                raise RuntimeError('Fleet webhook queue accounting became negative')
            if time.monotonic() - began > deadline_seconds:
                raise RuntimeError('Fleet webhook drain exceeded its declared deadline')
            if not any(pending.values()):
                break
            time.sleep(.25)
        result = {}
        for project, receiver, ledger in self.items:
            identities = project.sql('SELECT event_id::text FROM public.bench_expected_events ORDER BY event_id LIMIT 100001').splitlines()
            if not identities or len(identities) > 100000:
                raise RuntimeError('Fleet webhook positive traffic is absent or exceeds its evidence budget')
            evidence = ledger.validate(str(uuid.UUID(identity)) for identity in identities)
            evidence.update(outstanding=pending[project.label], signature_errors=len(receiver.errors))
            result[project.label] = evidence
            if evidence['missing'] or evidence['extra'] or evidence['signature_errors']:
                raise RuntimeError('Fleet committed webhook identities did not reconcile')
        return result

    def close(self):
        failures = []
        for project, receiver, ledger in self.items:
            for owner in [receiver, ledger]:
                try:
                    owner.close()
                except Exception as error:
                    failures.append({'project': project.label, 'owner': type(owner).__name__, 'error_type': type(error).__name__})
        return failures

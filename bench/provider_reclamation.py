"""Verify physical garbage reclamation without treating directory blocks as data."""
from arrival_counters import finite


def verify(before, after_delete, final, deleted_inventory, final_inventory):
    """Audit frozen observations; this does not rewrite the producing run's verdict."""
    for inventory in [deleted_inventory, final_inventory]:
        if not isinstance(inventory, dict) or set(inventory) != {'objects','bytes','multipart_uploads'} or any(type(value) is not int or value != 0 for value in inventory.values()):
            raise ValueError('Unreleased objects or multipart uploads remain in the provider API')
    for snapshot in [before, after_delete, final]:
        if not isinstance(snapshot, dict) or any(type(snapshot.get(key)) is not int or not 0 <= snapshot[key] <= 2**53 for key in ['disk_mib','trash_kib','trash_entries']):
            raise ValueError('Missing or invalid physical provider namespace evidence')
        elapsed = snapshot.get('elapsed_seconds')
        if not finite(elapsed) or not 0 <= elapsed <= 21600:
            raise ValueError('Missing finite provider observation time')
    if not before['elapsed_seconds'] < after_delete['elapsed_seconds'] < final['elapsed_seconds'] or final['elapsed_seconds']-after_delete['elapsed_seconds'] < 300:
        raise ValueError('Missing full automatic cleanup observation window')
    if after_delete['trash_entries'] <= before['trash_entries'] or after_delete['trash_kib'] <= before['trash_kib'] or after_delete['disk_mib'] <= before['disk_mib']:
        raise ValueError('No actual deleted physical data was observed')
    # One logical object can own multiple data/metadata directories. An empty
    # directory still has allocated blocks; entry count is the ownership oracle.
    if final['trash_entries'] != 0 or final['trash_kib'] > before['trash_kib'] or final['disk_mib'] > before['disk_mib']:
        raise ValueError('Physical provider garbage did not release its namespace and return to its initial footprint')
    return {'status':'passed','scope':'post-hoc physical garbage reclamation analysis only; original run verdict unchanged',
            'reclaimed_trash_kib':after_delete['trash_kib']-final['trash_kib'],
            'reclaimed_physical_entries':after_delete['trash_entries'],
            'empty_directory_allocation_kib':final['trash_kib'],
            'post_delete_observation_seconds':final['elapsed_seconds']-after_delete['elapsed_seconds']}

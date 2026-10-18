"""Declare and verify CPU sharing without expanding the role affinity budget."""


def allocation(projects, cpus, period, policy):
    if isinstance(projects, bool) or not isinstance(projects, int) or projects not in (1, 5, 10) or isinstance(period, bool) or not isinstance(period, int) or period not in (10000, 100000) or policy not in ('quota', 'shared'):
        raise ValueError('Invalid independent-project CPU allocation')
    if not isinstance(cpus, (list, tuple)) or len(cpus) < 3 or any(isinstance(cpu, bool) or not isinstance(cpu, int) or cpu < 0 for cpu in cpus) or len(set(cpus)) != len(cpus):
        raise ValueError('Target roles and generator need distinct CPU affinity slots')
    divisor = projects
    if policy == 'shared':
        divisor = 1
    quota, remainder = divmod(period, divisor)
    if remainder or quota < 1000:
        raise ValueError('Unrepresentable project CPU allocation')
    return {'policy': policy, 'projects': projects,
            'affinity_slots': {'app': cpus[0], 'postgres': cpus[1], 'generator': cpus[2]},
            'quota_usec_each': quota, 'period_usec': period,
            'configured_quota_sum_per_role': projects * quota / period,
            'hard_cpu_ceiling_per_role': 1,
            'quota_oversubscription_within_one_slot': policy == 'shared' and projects > 1}


def checked(value, projects, cpus, period):
    if not isinstance(value, dict):
        raise ValueError('Missing project CPU allocation')
    expected = allocation(projects, cpus, period, value.get('policy'))
    integers = ['projects', 'quota_usec_each', 'period_usec', 'hard_cpu_ceiling_per_role']
    slots = value.get('affinity_slots')
    if not isinstance(slots, dict) or set(slots) != {'app', 'postgres', 'generator'} or any(type(slot) is not int for slot in slots.values()) or any(type(value.get(key)) is not int for key in integers) or type(value.get('configured_quota_sum_per_role')) is not float or type(value.get('quota_oversubscription_within_one_slot')) is not bool or value != expected:
        raise ValueError('Invalid or inconsistent typed CPU allocation')
    return expected


def validate_proof(value, declared):
    if not isinstance(value, dict) or value.get('status') != 'passed' or value.get('allocation') != declared:
        raise ValueError('Missing native CPU allocation evidence')
    slots = declared['affinity_slots']
    checked(value['allocation'], declared['projects'], [slots['app'], slots['postgres'], slots['generator']], declared['period_usec'])
    rows = value.get('containers')
    if not isinstance(rows, list) or len(rows) != 2 * declared['projects']:
        raise ValueError('Incomplete native CPU owner census')
    expected = {(f'project-{index}', role) for index in range(declared['projects']) for role in ['app', 'postgres']}
    observed = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Malformed native CPU evidence')
        project, role = row.get('project'), row.get('role')
        if not isinstance(project, str) or not isinstance(role, str) or (project, role) not in expected or (project, role) in observed:
            raise ValueError('Unexpected or duplicate native CPU owner')
        if type(row.get('quota_usec')) is not int or type(row.get('period_usec')) is not int or row['quota_usec'] != declared['quota_usec_each'] or row['period_usec'] != declared['period_usec'] or row.get('effective_affinity') != str(declared['affinity_slots'][role]):
            raise ValueError('Native CPU evidence differs from the declared bound')
        observed.add((project, role))
    if observed != expected:
        raise ValueError('Missing native CPU owners')


def verify(owned, projects, declared):
    """Read the real owned namespaces before traffic; masks cannot span roles."""
    slots = declared['affinity_slots']
    expected = checked(declared, declared['projects'], [slots['app'], slots['postgres'], slots['generator']], declared['period_usec'])
    if declared != expected or len(projects) != declared['projects'] or {project.label for project in projects} != {'project-' + str(index) for index in range(len(projects))}:
        raise ValueError('CPU allocation does not match the independent topology')
    names = [name for project in projects for name in [project.app, project.pg]]
    if len(set(names)) != len(names):
        raise ValueError('Independent CPU owners must be distinct')
    observations = []
    command = 'set -eu; for field in cpuset.cpus.effective cpu.max; do IFS= read -r value < "/sys/fs/cgroup/$field"; printf "%s\\n" "$value"; done'
    for project in projects:
        for role, name in [('app', project.app), ('postgres', project.pg)]:
            rows = owned('exec', name, 'sh', '-c', command).splitlines()
            if len(rows) != 2 or rows[0] != str(slots[role]):
                raise ValueError('Actual project affinity escapes its single declared role slot')
            values = rows[1].split()
            if len(values) != 2 or not all(value.isascii() and value.isdecimal() for value in values) or list(map(int, values)) != [declared['quota_usec_each'], declared['period_usec']]:
                raise ValueError('Actual project quota differs from its declared policy')
            observations.append({'project': project.label, 'role': role,
                                 'effective_affinity': rows[0],
                                 'quota_usec': int(values[0]), 'period_usec': int(values[1])})
    proof = {'status': 'passed', 'scope': 'Native kernel affinity/quota verification before offered traffic; no throughput certification',
             'allocation': declared, 'containers': observations}
    validate_proof(proof, declared)
    return proof

var assert = require('chai').assert;
var errors = require('../src/errors');
var objects = require('../src/objects');
var query = require('../src/query');
var util = require('./util');

var FaunaDate = objects.FaunaDate,
  FaunaTime = objects.FaunaTime,
  Ref = objects.Ref,
  SetRef = objects.SetRef;

var client = util.client;

var classRef, nIndexRef, mIndexRef, refN1, refM1, refN1M1, thimbleClassRef;

describe('query', function () {
  before(function () {
    client.post('classes', {name: 'widgets'}).then(function(instance) {
      var classRef = instance.ref;

      var nIndexRefP = client.post('indexes', {
        name: 'widgets_by_n',
        source: classRef,
        path: 'data.n',
        active: true
      }).then(function(i) { nIndexRef = i.ref });

      var mIndexRefP = client.post('indexes', {
        name: 'widgets_by_m',
        source: classRef,
        path: 'data.m',
        active: true
      }).then(function(i) { mIndexRef = i.ref });

      var refN1P = create({n:1}).then(function(i) {refN1 = i.ref});
      var refM1P = create({m:1}).then(function(i) {refM1 = i.ref});
      var refN1M1P = create({n:1,m:1}).then(function(i) { refN1M1 = i.ref });
      var thimbleClassRefP  = client.post('classes', {name:'thimbles'}).then(function(i) { thimbleClassRef = i.ref });

      return Promise.all([nIndexRefP, mIndexRefP, refN1P, refM1P, refN1M1P, thimbleClassRefP]);
    });
  });

  // Basic forms

  it('let/var', function () {
    assertQuery(query.let_expr({x: 1}, query.variable('x')), 1);
  });

  it('if', function () {
    assertQuery(query.if_expr(true, 't', 'f'), 't');
    assertQuery(query.if_expr(false, 't', 'f'), 'f');
  });

  it('do', function () {
    create().then(function(i) {
      var ref = i.ref;
      return assertQuery(query.do_expr(query.delete_expr(ref), 1), 1).then(function () {
        assertQuery(query.exists(ref), false);
      });
    });
  });

  it('object', function () {
    var obj = query.object({x: query.let_expr({x: 1}, query.variable('x'))});
    assertQuery(obj, {x: 1});
  });

  it('quote', function () {
    var quoted = query.let_expr({x: 1}, query.variable('x'));
    assertQuery(query.quote(quoted), quoted);
  });

  it('lambda', function () {
    assert.throws(function () {query.lambda(function () { return 0 })});

    assert.deepEqual(
      query.lambda(function(a) { query.add(a, a) }),
      {lambda: 'a', expr: {add: [{var: 'a'}, {var: 'a'}]}});

    var multi_args = query.lambda(function(a, b) { return [b, a] });
    assert.deepEqual(multi_args, {
      lambda: ['a', 'b'],
      expr: [{var: 'b'}, {var: 'a'}]
    });

    assertQuery(query.map([[1, 2], [3, 4]], multi_args), [[2, 1], [4, 3]]);

    // function() works too
    assert.deepEqual(multi_args, query.lambda(function(a, b) { return [b, a] }));
  });

  // Collection functions

  it('map', function () {
    assertQuery(query.map([1, 2, 3], function(a) { query.multiply([2, a])}), [2, 4, 6]);
    // Should work for manually constructed lambda too.
    assertQuery(
      query.map([1, 2, 3], query.lambda_expr('a', query.multiply([2, query.variable('a')]))),
      [2, 4, 6]);

    var page = query.paginate(nSet(1));
    var ns = query.map(page, function(a) { query.select(['data', 'n'], query.get(a))});
    assertQuery(ns, {data: [1, 1]});
  });

  it('foreach', function () {
    Promise.all([create(), create()]).then(function(results) {
      return [results[0].ref, results[1].ref];
    }).then(function(refs) {
      client.query(query.foreach(refs, query.delete_expr));
      for (var ref in refs) {
        assertQuery(query.exists(ref), false);
      }
    });
  });

  it('filter', function () {
    assertQuery(query.filter([1, 2, 3, 4], function(a) { query.equals(query.modulo(a, 2), 0)}), [2, 4]);

    // Works on page too
    var page = query.paginate(nSet(1));
    var refsWithM = query.filter(page, function(a) {
      query.contains(['data', 'm'], query.get(a))});
    assertQuery(refsWithM, {data: [refN1M1]});
  });

  it('take', function () {
    assertQuery(query.take(1, [1, 2]), [1]);
    assertQuery(query.take(3, [1, 2]), [1, 2]);
    assertQuery(query.take(-1, [1, 2]), []);
  });

  it('drop', function () {
    assertQuery(query.drop(1, [1, 2]), [2]);
    assertQuery(query.drop(3, [1, 2]), []);
    assertQuery(query.drop(-1, [1, 2]), [1, 2]);
  });

  it('prepend', function () {
    assertQuery(query.prepend([1, 2, 3], [4, 5, 6]), [1, 2, 3, 4, 5, 6]);
    // Fails for non-array.
    assertBadQuery(query.prepend([1, 2], 'foo'));
  });

  it('append', function () {
    assertQuery(query.append([4, 5, 6], [1, 2, 3]), [1, 2, 3, 4, 5, 6]);
    // Fails for non-array.
    assertBadQuery(query.append([1, 2], 'foo'));
  });

  // Read functions

  it('get', function () {
    create().then(function(instance) {
      assertQuery(query.get(instance.ref), instance);
    });
  });

  it('paginate', function () {
    var testSet = nSet(1);
    assertQuery(query.paginate(testSet), {data: [refN1, refN1M1]});
    assertQuery(query.paginate(testSet, {size: 1}), {data: [refN1], after: [refN1M1]});
    assertQuery(query.paginate(testSet, {sources: true}), {
      data: [
        {sources: [new SetRef(testSet)], value: refN1},
        {sources: [new SetRef(testSet)], value: refN1M1}
      ]
    });
  });

  it('exists', function () {
    create().then(function(i) {
      var ref = i.ref;
      assertQuery(query.exists(ref), true);
      client.query(query.delete_expr(ref));
      assertQuery(query.exists(ref), false);
    });
  });

  it('count', function () {
    create({n: 123});
    create({n: 123});
    var instances = nSet(123);
    // `count` is currently only approximate. Should be 2.
    return client.query(query.count(instances)).then(function(count) {
      assert.typeOf(count, 'number');
    });
  });

  // Write functinos

  it('create', function () {
    create().then(function(instance) {
      assert('ref' in instance);
      assert('ts' in instance);
      assert.deepEqual(instance.class, classRef);
    });
  });

  it('update', function () {
    create().then(function(i) {
      var ref = i.ref;
      return client.query(query.update(ref, query.quote({data: {m: 9}})));
    }).then(function(got) {
      assert.deepEqual(got.data, {n: 0, m: 9});
    });
  });

  it('replace', function () {
    create().then(function(i) {
      var ref = i.ref;
      return client.query(query.replace(ref, query.quote({data: {m: 9}})));
    }).then(function(got) {
      assert.deepEqual(got.data, {m: 9})
    });
  });

  it('delete', function () {
    create().then(function(i) {
      var ref = i.ref;
      client.query(query.delete_expr(ref)).then(function() {
        assertQuery(query.exists(ref), false);
      });
    });
  });

  it('insert', function () {
    createThimble({weight: 1}).then(function(instance) {
      var ref = instance.ref;
      var ts = instance.ts;
      var prevTs = ts - 1;

      var inserted = query.quote({data: {weight: 0}})

      client.query(query.insert(ref, prevTs, 'create', inserted)).then(function() {
        return client.query(query.get(ref, prevTs));
      }).then(function(old) {
        assert.deepEqual(old.data, {weight: 0})
      });
    });
  });

  it('remove', function () {
    createThimble({weight: 0}).then(function(instance) {
      var ref = instance.ref

      client.query(query.replace(ref, query.quote({data: {weight: 1}}))).then(function(newInstance) {
        assertQuery(query.get(ref), newInstance).then(function() {
          return client.query(query.remove(ref, newInstance.ts, 'create'))
        }).then(function() {
          assertQuery(query.get(ref), instance);
        });
      });
    });
  });

  // Sets

  it('match', function () {
    assertSet(nSet(1), [refN1, refN1M1]);
  });

  it('union', function () {
    assertSet(query.union(nSet(1), mSet(1)), [refN1, refM1, refN1M1]);
  });

  it('intersection', function () {
    assertSet(query.intersection(nSet(1), mSet(1)), [refN1M1]);
  });

  it('difference', function () {
    assertSet(query.difference(nSet(1), mSet(1)), [refN1]) // but not refN1M1
  });

  it('join', function () {
    Promise.all([create({n:12}), create({n:12})]).then(function(results) {
      var referenced = [results[0].ref, results[1].ref];

      return Promise.all([create({m: referenced[0]}), create({m: referenced[1]})]).then(function(results2) {
        var referencers = [results2[0].ref, results2[1].ref];
        var source = nSet(12);

        assertSet(source, referenced);

        // For each obj with n=12, get the set of elements whose data.m refers to it.
        var joined = query.join(source, function(a) { query.match(mIndexRef, a) });
        assertSet(joined, referencers);
      });
    });
  });

  // Authentication

  it('login/logout', async () => {
    const instanceRef = (await client.query(
      query.create(classRef, query.quote({credentials: {password: 'sekrit'}})))).ref
    const secret = (await client.query(
      query.login(instanceRef, query.quote({password: 'sekrit'})))).secret
    const instanceClient = util.getClient({secret: {user: secret}})

    assert.deepEqual(
      await instanceClient.query(
        query.select('ref', query.get(new Ref('classes/widgets/self')))),
      instanceRef)

    assert.isTrue(await instanceClient.query(query.logout(true)))
  })

  it('identify', async () => {
    const instanceRef = (await client.query(
      query.create(classRef, query.quote({credentials: {password: 'sekrit'}})))).ref
    await assertQuery(query.identify(instanceRef, 'sekrit'), true)
  })

  // String functions

  it('concat', async () => {
    await assertQuery(query.concat(['a', 'b', 'c']), 'abc')
    await assertQuery(query.concat([]), '')
    await assertQuery(query.concat(['a', 'b', 'c'], '.'), 'a.b.c')
  })

  it('casefold', async () => {
    await assertQuery(query.casefold('Hen Wen'), 'hen wen')
  })

  // Time and date functions

  it('time', async () => {
    const time = '1970-01-01T00:00:00.123456789Z'
    await assertQuery(query.time(time), new FaunaTime(time))
    // 'now' refers to the current time.
    assert.instanceOf(await client.query(query.time('now')), FaunaTime)
  })

  it('epoch', async () => {
    await assertQuery(query.epoch(12, 'second'), new FaunaTime('1970-01-01T00:00:12Z'))
    const nanoTime = new FaunaTime('1970-01-01T00:00:00.123456789Z')
    await assertQuery(query.epoch(123456789, 'nanosecond'), nanoTime)
  })

  it('date', async () => {
    await assertQuery(query.date('1970-01-01'), new FaunaDate('1970-01-01'))
  })

  // Miscellaneous functions

  it('equals', async () => {
    await assertQuery(query.equals(1, 1, 1), true)
    await assertQuery(query.equals(1, 1, 2), false)
    await assertQuery(query.equals(1), true)
    await assertBadQuery(query.equals())
  })

  it('contains', async () => {
    const obj = query.quote({a: {b: 1}})
    await assertQuery(query.contains(['a', 'b'], obj), true)
    await assertQuery(query.contains('a', obj), true)
    await assertQuery(query.contains(['a', 'c'], obj), false)
  })

  it('select', async () => {
    const obj = query.quote({a: {b: 1}})
    await assertQuery(query.select('a', obj), {b: 1})
    await assertQuery(query.select(['a', 'b'], obj), 1)
    await assertQuery(query.selectWithDefault('c', obj, null), null)
    await assertBadQuery(query.select('c', obj), errors.NotFound)
  })

  it('select for array', async () => {
    const arr = [1, 2, 3]
    await assertQuery(query.select(2, arr), 3)
    await assertBadQuery(query.select(3, arr), errors.NotFound)
  })

  it('add', async () => {
    await assertQuery(query.add(2, 3, 5), 10)
    await assertBadQuery(query.add())
  })

  it('multiply', async () => {
    await assertQuery(query.multiply(2, 3, 5), 30)
    await assertBadQuery(query.multiply())
  })

  it('subtract', async () => {
    await assertQuery(query.subtract(2, 3, 5), -6)
    await assertQuery(query.subtract(2), 2)
    await assertBadQuery(query.subtract())
  })

  it('divide', async () => {
    // TODO: can't make this query because 2.0 === 2
    // await assertQuery(query.divide(2, 3, 5), 2/15)
    await assertQuery(query.divide(2), 2)
    await assertBadQuery(query.divide(1, 0))
    await assertBadQuery(query.divide())
  })

  it('modulo', async () => {
    await assertQuery(query.modulo(5, 2), 1)
    // This is (15 % 10) % 2
    await assertQuery(query.modulo(15, 10, 2), 1)
    await assertQuery(query.modulo(2), 2)
    await assertBadQuery(query.modulo(1, 0))
    await assertBadQuery(query.modulo())
  })

  it('lt', async () => {
    await assertQuery(query.lt(1, 2), true)
  })

  it('lte', async () => {
    await assertQuery(query.lte(1, 1), true)
  })

  it('gt', async () => {
    await assertQuery(query.gt(2, 1), true)
  })

  it('gte', async () => {
    await assertQuery(query.gte(1, 1), true)
  })

  it('and', async () => {
    await assertQuery(query.and(true, true, false), false)
    await assertQuery(query.and(true, true, true), true)
    await assertQuery(query.and(true), true)
    await assertQuery(query.and(false), false)
    await assertBadQuery(query.and())
  })

  it('or', async () => {
    await assertQuery(query.or(false, false, true), true)
    await assertQuery(query.or(false, false, false), false)
    await assertQuery(query.or(true), true)
    await assertQuery(query.or(false), false)
    await assertBadQuery(query.or())
  })

  it('not', async () => {
    await assertQuery(query.not(true), false)
    await assertQuery(query.not(false), true)
  })

  // Helpers

  it('varargs', async () => {
    // Works for lists too
    await assertQuery(query.add([2, 3, 5]), 10)
    // Works for a variable equal to a list
    await assertQuery(query.let_expr({x: [2, 3, 5]}, query.add(query.variable('x'))), 10)
  })
});

function create(data={}) {
  if (data.n === undefined)
    data.n = 0
  return client.query(query.create(classRef, query.quote({data})))
}
function createThimble(data) {
  return client.query(query.create(thimbleClassRef, query.quote({data})))
}

function nSet(n) {
  return query.match(nIndexRef, n)
}
function mSet(m) {
  return query.match(mIndexRef, m)
}

async function assertQuery(query, expected) {
  assert.deepEqual(await client.query(query), expected)
}
async function assertBadQuery(query, errorType=errors.BadRequest) {
  await util.assertRejected(client.query(query), errorType)
}
async function assertSet(set, expected) {
  assert.deepEqual(await getSetContents(set), expected)
}
async function getSetContents(set) {
  return (await client.query(query.paginate(set, {size: 1000}))).data
}

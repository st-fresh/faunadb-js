'use strict';

var assert = require('chai').assert;
var errors = require('../src/errors');
var values = require('../src/values');
var query = require('../src/query');
var util = require('./util');
var Promise = require('es6-promise').Promise;

var Ref = query.Ref;

var FaunaDate = values.FaunaDate,
  FaunaTime = values.FaunaTime,
  SetRef = values.SetRef,
  Bytes = values.Bytes;

var client;

var classRef, nIndexRef, mIndexRef, nCoveredIndexRef, refN1, refM1, refN1M1, thimbleClassRef;

describe('query', function () {
  this.timeout(10000);
  before(function () {
    // Hideous way to ensure that the client is initialized.
    client = util.client();

    return client.query(query.CreateClass({ name: 'widgets' })).then(function (instance) {
      classRef = instance.ref;
      var nIndexRefP = client.query(query.CreateIndex({
        name: 'widgets_by_n',
        source: classRef,
        terms: [ { 'field': ['data', 'n'] }]
      })).then(function(i) { nIndexRef = i.ref; });

      var mIndexRefP = client.query(query.CreateIndex({
        name: 'widgets_by_m',
        source: classRef,
        terms: [ { 'field': ['data', 'm'] }]
      })).then(function(i) { mIndexRef = i.ref; });

      var nCoveredIndexRefP = client.query(query.CreateIndex({
        name: 'widgets_cost_by_p',
        source: classRef,
        terms: [ { 'field': ['data', 'p' ] }],
        values: [ { 'field': ['data', 'cost' ] }]
      })).then(function(i) { nCoveredIndexRef = i.ref; });

      return Promise.all([nIndexRefP, mIndexRefP, nCoveredIndexRefP]).then(function() {
        var createP = create({ n: 1, p: 1, cost: 10 }).then(function (i) {
          refN1 = i.ref;
          return create({ m: 1, p: 1, cost: 15 });
        }).then(function (i) {
          refM1 = i.ref;
          return create({ n: 1, m: 1, p: 1, cost: 10 });
        }).then(function (i) { refN1M1 = i.ref; });
        var thimbleClassRefP = client.query(query.CreateClass({ name: 'thimbles' })).then(function (i) { thimbleClassRef = i.ref; });

        return Promise.all([createP, thimbleClassRefP]);
      });
    });
  });

  it('echo values', function () {
    var pInteger = client.query(10).then(function (res) {
      assert.equal(res, 10);
    });

    var pNumber = client.query(3.14).then(function (res) {
      assert.equal(res, 3.14);
    });

    var pString = client.query('string').then(function (res) {
      assert.equal(res, 'string');
    });

    var pObject = client.query({a: 1, b: 'string', c: 3.14, d: null}).then(function (res) {
      assert.deepEqual(res, {a: 1, b: 'string', c: 3.14, d: null});
    });

    var pArray = client.query([1, 'string', 3.14, null]).then(function (res) {
      assert.deepEqual(res, [1, 'string', 3.14, null]);
    });

    var pNull = client.query(null).then(function (res) {
      assert.equal(res, null);
    });

    return Promise.all([pInteger, pNumber, pString, pObject, pArray, pNull]);
  })

  // Basic forms
  it('at', function () {
    var client = util.client();

    var paginate = query.Paginate(nSet(1000));

    return create({ n: 1000 }).then(function (inst1) {
      return create({ n: 1000 }).then(function (inst2) {
        return create({ n: 1000 }).then(function (inst3) {
          var p1 = client.query(paginate).then(function (data) {
            assert.deepEqual(data.data, [inst1.ref, inst2.ref, inst3.ref], 'Should contains all instance with n=1000');
          });

          var p2 = client.query(query.At(inst1.ts, paginate)).then(function (data) {
            assert.deepEqual(data.data, [inst1.ref], 'Should contains only the first instance with n=1000');
          });

          return Promise.all([p1, p2]);
        });
      });
    });
  });

  it('let/var', function () {
    return assertQuery(query.Let({ x: 1 }, query.Var('x')), 1);
  });

  it('if', function () {
    var p1 = assertQuery(query.If(true, 't', 'f'), 't');
    var p2 = assertQuery(query.If(false, 't', 'f'), 'f');
    return Promise.all([p1, p2]);
  });

  it('do', function () {
    return create().then(function (i) {
      var ref = i.ref;
      return assertQuery(query.Do(query.Delete(ref), 1), 1).then(function () {
        assertQuery(query.Exists(ref), false);
      });
    });
  });

  it('object', function () {
    var obj = query.Object({ x: query.Let({ x: 1 }, query.Var('x')) });
    return assertQuery(obj, { x: 1 });
  });

  it('lambda', function () {
    assert.throws(function () { query.Lambda(function () { return 0; } ); });

    assert.deepEqual(
      util.unwrapExpr(query.Lambda(function (a) { return query.Add(a, a); })),
      { lambda: 'a', expr: { add: [{ var: 'a' }, { var: 'a' }] } });

    var multi_args = query.Lambda(function (a, b) { return [b, a]; });
    assert.deepEqual(util.unwrapExpr(multi_args), {
      lambda: ['a', 'b'],
      expr: [{ var: 'b' }, { var: 'a' }]
    });

    // function() works too
    assert.deepEqual(multi_args, query.Lambda(function (a, b) { return [b, a]; }));

    return assertQuery(query.Map([[1, 2], [3, 4]], multi_args), [[2, 1], [4, 3]]);
  });

  // Collection functions

  it('map', function () {
    var p1 = assertQuery(query.Map([1, 2, 3], function (a) { return query.Multiply([2, a]); } ), [2, 4, 6]);
    // Should work for manually constructed lambda too.
    var p2 = assertQuery(
      query.Map([1, 2, 3], query.Lambda('a', query.Multiply([2, query.Var('a')]))),
      [2, 4, 6]);

    var page = query.Paginate(nSet(1));
    var ns = query.Map(page, function (a) { return query.Select(['data', 'n'], query.Get(a)); });
    var p3 = assertQuery(ns, { data: [1, 1] });
    return Promise.all([p1, p2, p3]);
  });

  it('foreach', function () {
    return Promise.all([create(), create()]).then(function (results) {
      return [results[0].ref, results[1].ref];
    }).then(function (refs) {
      return client.query(query.Foreach(refs, query.Delete)).then(function() {
        var rv = [];
        refs.forEach(function(ref) {
          rv.push(assertQuery(query.Exists(ref), false));
        });

        return Promise.all(rv);
      });
    });
  });

  it('filter', function () {
    var p1 = assertQuery(query.Filter([1, 2, 3, 4], function (a) { return query.Equals(query.Modulo(a, 2), 0); } ), [2, 4]);

    // Works on page too
    var page = query.Paginate(nSet(1));
    var refsWithM = query.Filter(page, function (a) {
      return query.Contains(['data', 'm'], query.Get(a));
    });
    var p2 = assertQuery(refsWithM, { data: [refN1M1] });

    return Promise.all([p1, p2]);
  });

  it('take', function () {
    var p1 = assertQuery(query.Take(1, [1, 2]), [1]);
    var p2 = assertQuery(query.Take(3, [1, 2]), [1, 2]);
    var p3 = assertQuery(query.Take(-1, [1, 2]), []);

    return Promise.all([p1, p2, p3]);
  });

  it('drop', function () {
    var p1 = assertQuery(query.Drop(1, [1, 2]), [2]);
    var p2 = assertQuery(query.Drop(3, [1, 2]), []);
    var p3 = assertQuery(query.Drop(-1, [1, 2]), [1, 2]);

    return Promise.all([p1, p2, p3]);
  });

  it('prepend', function () {
    var p1 = assertQuery(query.Prepend([1, 2, 3], [4, 5, 6]), [1, 2, 3, 4, 5, 6]);
    // Fails for non-array.
    var p2 = assertBadQuery(query.Prepend([1, 2], 'foo'));

    return Promise.all([p1, p2]);
  });

  it('append', function () {
    var p1 = assertQuery(query.Append([4, 5, 6], [1, 2, 3]), [1, 2, 3, 4, 5, 6]);
    // Fails for non-array.
    var p2 = assertBadQuery(query.Append([1, 2], 'foo'));

    return Promise.all([p1, p2]);
  });

  // Read functions

  it('get', function () {
    return create().then(function (instance) {
      return assertQuery(query.Get(instance.ref), instance);
    });
  });

  it('key_from_secret', function () {
    var client = util.rootClient;

    return client.query(query.CreateKey({ database: util.dbRef, role: 'server' })).then(function(key) {
      var p1 = client.query(query.Get(key.ref));
      var p2 = client.query(query.KeyFromSecret(key.secret));

      return Promise.all([p1, p2]).then(function(keys) {
        assert.deepEqual(keys[0], keys[1]);
      });
    });
  });

  it('paginate', function () {
    var testSet = nSet(1);
    var p1 = assertQuery(query.Paginate(testSet), { data: [refN1, refN1M1] });
    var p2 = assertQuery(query.Paginate(testSet, { size: 1 }), { data: [refN1], after: [refN1M1] });
    var p3 = assertQuery(query.Paginate(testSet, { sources: true }), {
      data: [
        { sources: [new SetRef(util.unwrapExpr(testSet))], value: refN1 },
        { sources: [new SetRef(util.unwrapExpr(testSet))], value: refN1M1 }
      ]
    });

    return Promise.all([p1, p2, p3]);
  });

  it('exists', function () {
    return create().then(function (i) {
      var ref = i.ref;
      return assertQuery(query.Exists(ref), true).then(function() {
        return client.query(query.Delete(ref));
      }).then(function() {
        return assertQuery(query.Exists(ref), false);
      });
    });
  });

  // Write functions

  it('create', function () {
    return create().then(function (instance) {
      assert('ref' in instance);
      assert('ts' in instance);
      assert.deepEqual(instance.class, classRef);
    });
  });

  it('update', function () {
    return create().then(function (i) {
      var ref = i.ref;
      return client.query(query.Update(ref, { data: { m: 9 } })).then(function (got) {
        assert.deepEqual(got.data, { n: 0, m: 9 });
        return client.query(query.Update(ref, { data: { m: null } }));
      }).then(function (got) {
        assert.deepEqual(got.data, { n: 0 });
      });
    });
  });

  it('replace', function () {
    return create().then(function (i) {
      var ref = i.ref;
      return client.query(query.Replace(ref, { data: { m: 9 } }));
    }).then(function (got) {
      assert.deepEqual(got.data, { m: 9 });
    });
  });

  it('delete', function () {
    return create().then(function (i) {
      var ref = i.ref;
      client.query(query.Delete(ref)).then(function () {
        assertQuery(query.Exists(ref), false);
      });
    });
  });

  it('insert', function () {
    return createThimble({ weight: 1 }).then(function (instance) {
      var ref = instance.ref;
      var ts = instance.ts;
      var prevTs = ts - 1;

      var inserted = { data: { weight: 0 } };

      return client.query(query.Insert(ref, prevTs, 'create', inserted)).then(function () {
        return client.query(query.Get(ref, prevTs));
      }).then(function (old) {
        assert.deepEqual(old.data, { weight: 0 });
      });
    });
  });

  it('remove', function () {
    return createThimble({ weight: 0 }).then(function (instance) {
      var ref = instance.ref;

      return client.query(query.Replace(ref, { data: { weight: 1 } })).then(function (newInstance) {
        return assertQuery(query.Get(ref), newInstance).then(function () {
          return client.query(query.Remove(ref, newInstance.ts, 'create'));
        }).then(function () {
          return assertQuery(query.Get(ref), instance);
        });
      });
    });
  });

  // Sets

  it('match', function () {
    return assertSet(nSet(1), [refN1, refN1M1]);
  });

  it('union', function () {
    return assertSet(query.Union(nSet(1), mSet(1)), [refN1, refM1, refN1M1]);
  });

  it('intersection', function () {
    return assertSet(query.Intersection(nSet(1), mSet(1)), [refN1M1]);
  });

  it('difference', function () {
    return assertSet(query.Difference(nSet(1), mSet(1)), [refN1]); // but not refN1M1
  });

  it('distinct', function() {
    var nonDistinctP = assertSet(query.Match(nCoveredIndexRef, 1), [10, 10, 15]);
    var distinctP = assertSet(query.Distinct(query.Match(nCoveredIndexRef, 1)), [10, 15]);

    return Promise.all([nonDistinctP, distinctP]);
  });

  it('join', function () {
    return create({ n: 12 }).then(function(res1) {
      return create({ n: 12 }).then(function(res2) {
        return [res1.ref, res2.ref];
      });
    }).then(function(referenced) {
      return create({ m: referenced[0] }).then(function(res1) {
        return create({ m: referenced[1] }).then(function(res2) {
          return [res1.ref, res2.ref];
        });
      }).then(function (referencers) {
        var source = nSet(12);

        var p1 = assertSet(source, referenced);

        // For each obj with n=12, get the set of elements whose data.m refers to it.
        var joined = query.Join(source, function (a) { return query.Match(mIndexRef, a); });
        var p2 = assertSet(joined, referencers);

        var joinedNonLambda = query.Join(source, mIndexRef);
        var p3 = assertSet(joinedNonLambda, referencers);
        return Promise.all([p1, p2, p3]);
      });
    });
  });

  // Authentication

  it('login/logout', function () {
    return client.query(query.Create(classRef, { credentials: { password: 'sekrit' } })).then(function (result) {
      var instanceRef = result.ref;
      return client.query(query.Login(instanceRef, { password: 'sekrit' })).then(function (result2) {
        var secret = result2.secret;
        var instanceClient = util.getClient({ secret: secret });

        return instanceClient.query(query.Select('ref', query.Get(Ref('classes/widgets/self')))).then(function (result3) {
          assert.deepEqual(result3, instanceRef);

          return instanceClient.query(query.Logout(true));
        }).then(function (logoutResult) {
          assert.isTrue(logoutResult);
        });
      });
    });
  });

  it('identify', function () {
    return client.query(query.Create(classRef, { credentials: { password: 'sekrit' } })).then(function (result) {
      var instanceRef = result.ref;
      return assertQuery(query.Identify(instanceRef, 'sekrit'), true);
    });
  });

  // String functions

  it('concat', function () {
    var p1 = assertQuery(query.Concat(['a', 'b', 'c']), 'abc');
    var p2 = assertQuery(query.Concat([]), '');
    var p3 = assertQuery(query.Concat(['a', 'b', 'c'], '.'), 'a.b.c');

    return Promise.all([p1, p2, p3]);
  });

  it('casefold', function () {
    return assertQuery(query.Casefold('Hen Wen'), 'hen wen');
  });

  // Time and date functions

  it('time', function () {
    var time = '1970-01-01T00:00:00.123456789Z';
    var p1 = assertQuery(query.Time(time), new FaunaTime(time));
    // 'now' refers to the current time.
    var p2 = client.query(query.Time('now')).then(function (result) {
      assert.instanceOf(result, FaunaTime);
    });

    return Promise.all([p1, p2]);
  });

  it('epoch', function () {
    var p1 = assertQuery(query.Epoch(12, 'second'), new FaunaTime('1970-01-01T00:00:12Z'));
    var nanoTime = new FaunaTime('1970-01-01T00:00:00.123456789Z');
    var p2 = assertQuery(query.Epoch(123456789, 'nanosecond'), nanoTime);
    return Promise.all([p1, p2]);
  });

  it('date', function () {
    return assertQuery(query.Date('1970-01-01'), new FaunaDate('1970-01-01'));
  });

  // Miscellaneous functions
  it('next_id', function() {
    return client.query(query.NextId()).then(function(res) {
      var parsed = parseInt(res);
      assert.isNotNaN(parsed);
      assert.isNumber(parsed);
    });
  });

  it('index', function() {
    return client.query(query.Index("widgets_by_n")).then(function(res) {
      assert.equal(res.value, nIndexRef.value);
    });
  });

  it('class', function() {
    return client.query(query.Class("widgets")).then(function(res) {
      assert.equal(res.value, classRef.value);
    });
  });

  it('equals', function () {
    var p1 = assertQuery(query.Equals(1, 1, 1), true);
    var p2 = assertQuery(query.Equals(1, 1, 2), false);
    var p3 = assertQuery(query.Equals(1), true);
    return Promise.all([p1, p2, p3]);
  });

  it('contains', function () {
    var obj = { a: { b: 1 } };
    var p1 = assertQuery(query.Contains(['a', 'b'], obj), true);
    var p2 = assertQuery(query.Contains('a', obj), true);
    var p3 = assertQuery(query.Contains(['a', 'c'], obj), false);
    return Promise.all([p1, p2, p3]);
  });

  it('select', function () {
    var obj = { a: { b: 1 } };
    var p1 = assertQuery(query.Select('a', obj), { b: 1 });
    var p2 = assertQuery(query.Select(['a', 'b'], obj), 1);
    var p3 = assertQuery(query.Select('c', obj, null), null);
    var p4 = assertBadQuery(query.Select('c', obj), errors.NotFound);
    return Promise.all([p1, p2, p3, p4]);
  });

  it('select for array', function () {
    var arr = [1, 2, 3];
    var p1 = assertQuery(query.Select(2, arr), 3);
    var p2 = assertBadQuery(query.Select(3, arr), errors.NotFound);
    return Promise.all([p1, p2]);
  });

  it('add', function () {
    return assertQuery(query.Add(2, 3, 5), 10);
  });

  it('multiply', function () {
    return assertQuery(query.Multiply(2, 3, 5), 30);
  });

  it('subtract', function () {
    var p1 = assertQuery(query.Subtract(2, 3, 5), -6);
    var p2 = assertQuery(query.Subtract(2), 2);
    return Promise.all([p1, p2]);
  });

  it('divide', function () {
    // TODO: can't make this query because 2.0 === 2
    // await assertQuery(query.Divide(2, 3, 5), 2/15)
    var p1 = assertQuery(query.Divide(2), 2);
    var p2 = assertBadQuery(query.Divide(1, 0));
    return Promise.all([p1, p2]);
  });

  it('modulo', function () {
    var p1 = assertQuery(query.Modulo(5, 2), 1);
    // This is (15 % 10) % 2
    var p2 = assertQuery(query.Modulo(15, 10, 2), 1);
    var p3 = assertQuery(query.Modulo(2), 2);
    var p4 = assertBadQuery(query.Modulo(1, 0));
    return Promise.all([p1, p2, p3, p4]);
  });

  it('lt', function () {
    return assertQuery(query.LT(1, 2), true);
  });

  it('lte', function () {
    return assertQuery(query.LTE(1, 1), true);
  });

  it('gt', function () {
    return assertQuery(query.GT(2, 1), true);
  });

  it('gte', function () {
    return assertQuery(query.GTE(1, 1), true);
  });

  it('and', function () {
    var p1 = assertQuery(query.And(true, true, false), false);
    var p2 = assertQuery(query.And(true, true, true), true);
    var p3 = assertQuery(query.And(true), true);
    var p4 = assertQuery(query.And(false), false);
    return Promise.all([p1, p2, p3, p4]);
  });

  it('or', function () {
    var p1 = assertQuery(query.Or(false, false, true), true);
    var p2 = assertQuery(query.Or(false, false, false), false);
    var p3 = assertQuery(query.Or(true), true);
    var p4 = assertQuery(query.Or(false), false);
    return Promise.all([p1, p2, p3, p4]);
  });

  it('not', function () {
    var p1 = assertQuery(query.Not(true), false);
    var p2 = assertQuery(query.Not(false), true);
    return Promise.all([p1, p2]);
  });

  it('ref', function() {
    var ref = query.Ref(classRef.value + "/123456");
    return assertQuery(query.Ref(classRef, query.Concat(["123", "456"])), ref);
  });

  it('bytes', function() {
    return Promise.all([
      assertQuery(new Bytes("AQIDBA=="), new Bytes("AQIDBA==")),
      assertQuery(new Uint8Array([0, 0, 0, 0]), new Bytes("AAAAAA==")),
      assertQuery(new ArrayBuffer(4), new Bytes("AAAAAA=="))
    ]);
  });

  // Check arity of all query functions

  it('arity', function () {
    // By default assume all functions should have strict arity
    var testParams = {
      'Ref': [3, 'from 1 to 2'],
      'Do': [0, 'at least 1'],
      'Lambda': [3, 'from 1 to 2'],
      'Get': [3, 'from 1 to 2'],
      'Paginate': [3, 'from 1 to 2'],
      'Exists': [3, 'from 1 to 2'],
      'Create': [3, 'from 1 to 2'],
      'Match': [0, 'at least 1'],
      'Union': [0, 'at least 1'],
      'Intersection': [0, 'at least 1'],
      'Difference': [0, 'at least 1'],
      'Concat': [0, 'at least 1'],
      'Equals': [0, 'at least 1'],
      'Select': [4, 'from 2 to 3'],
      'Add': [0, 'at least 1'],
      'Multiply': [0, 'at least 1'],
      'Subtract': [0, 'at least 1'],
      'Divide': [0, 'at least 1'],
      'Modulo': [0, 'at least 1'],
      'LT': [0, 'at least 1'],
      'LTE': [0, 'at least 1'],
      'GT': [0, 'at least 1'],
      'GTE': [0, 'at least 1'],
      'And': [0, 'at least 1'],
      'Or': [0, 'at least 1']
    };

    for (var fun in query) {
      var params = testParams[fun] || [],
        arity = params[0] !== undefined ? params[0] : 100,
        errorMessage = new RegExp(
          'Function requires ' + (params[1] || '\\d+') +
            ' arguments but ' + arity + ' were given')

      assert.throws(function () { query[fun].apply(null, new Array(arity)); }, errors.InvalidArity, errorMessage, fun);
    }
  });


  // Helpers

  it('varargs', function () {
    // Works for lists too
    var p1 = assertQuery(query.Add([2, 3, 5]), 10);
    // Works for a variable equal to a list
    var p2 = assertQuery(query.Let({ x: [2, 3, 5] }, query.Add(query.Var('x'))), 10);
    return Promise.all([p1, p2]);
  });
});

function create(data) {
  if (typeof data === 'undefined') {
    data = {};
  }

  if (data.n === undefined) {
    data.n = 0;
  }

  return client.query(query.Create(classRef, { data: data }));
}

function createThimble(data) {
  return client.query(query.Create(thimbleClassRef, { data: data }));
}

function nSet(n) {
  return query.Match(nIndexRef, n);
}

function mSet(m) {
  return query.Match(mIndexRef, m);
}

function assertQuery(query, expected) {
  return client.query(query).then(function (result) {
    assert.deepEqual(result, expected);
  });
}

function assertBadQuery(query, errorType) {
  if (typeof errorType === 'undefined') {
    errorType = errors.BadRequest;
  }

  return util.assertRejected(client.query(query), errorType);
}

function assertSet(set, expected) {
  return getSetContents(set).then(function (result) {
    assert.deepEqual(result, expected);
  });
}

function getSetContents(set) {
  return client.query(query.Paginate(set, { size: 1000 })).then(function (result) {
    return result.data;
  });
}

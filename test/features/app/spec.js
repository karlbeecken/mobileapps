/* eslint-disable no-multiple-empty-lines */

'use strict';

const preq                   = require('preq');
const refParser              = require('json-schema-ref-parser-sync');
const assert                 = require('../../utils/assert.js');
const server                 = require('../../utils/server.js');
const URI                    = require('swagger-router').URI;
const specLib                = require('../../../lib/spec.js');
const OpenAPISchemaValidator = require('openapi-schema-validator').default;

const validator = new OpenAPISchemaValidator({ version: 3 });
const Ajv    = require('ajv');

const baseUri = `${server.config.uri}en.wikipedia.org/v1/`;

if (!server.stopHookAdded) {
	server.stopHookAdded = true;
	after(() => server.stop());
}

function staticSpecLoad() {

	const myService = server.config.conf.services[server.config.conf.services.length - 1].conf;
	const specPath = `${__dirname}/../../../${myService.spec ? myService.spec : 'spec'}`;

	return refParser.dereference(specLib.load(specPath, {}), function (err, schema) {
		if (err) {
			// this error will be detected later, so ignore it
			return { paths: {}, 'x-default-params': {} };
		} else {
			return schema;
		}
	});
}

function validateExamples(pathStr, defParams, mSpec) {

	const uri = new URI(pathStr, {}, true);

	if (!mSpec) {
		try {
			uri.expand(defParams);
			return true;
		} catch (e) {
			throw new Error(`Missing parameter for route ${pathStr} : ${e.message}`);
		}
	}

	if (!Array.isArray(mSpec)) {
		throw new Error(`Route ${pathStr} : x-amples must be an array!`);
	}

	mSpec.forEach((ex, idx) => {
		if (!ex.title) {
			throw new Error(`Route ${pathStr}, example ${idx}: title missing!`);
		}
		ex.request = ex.request || {};
		try {
			uri.expand(Object.assign({}, defParams, ex.request.params || {}));
		} catch (e) {
			throw new Error(
				`Route ${pathStr}, example ${idx} (${ex.title}): missing parameter: ${e.message}`
			);
		}
	});

	return true;

}

function constructTestCase(title, path, method, request, response) {

	return {
		title,
		request: {
			uri: server.config.uri + (path[0] === '/' ? path.substr(1) : path),
			method,
			headers: request.headers || {},
			query: request.query,
			body: request.body,
			followRedirect: false
		},
		response: {
			status: response.status || 200,
			headers: response.headers || {},
			body: response.body
		}
	};

}


function constructTests(paths, defParams) {

	const ret = [];

	Object.keys(paths).forEach((pathStr) => {
		Object.keys(paths[pathStr]).forEach((method) => {
			const p = paths[pathStr][method];
			if ({}.hasOwnProperty.call(p, 'x-monitor') && !p['x-monitor']) {
				return;
			}
			const uri = new URI(pathStr, {}, true);
			if (!p['x-amples']) {
				ret.push(constructTestCase(
					pathStr,
					uri.toString({ params: defParams }),
					method,
					{},
					{}
				));
				return;
			}
			p['x-amples'].forEach((ex) => {
				ex.request = ex.request || {};
				ret.push(constructTestCase(
					ex.title,
					uri.toString({
						params: Object.assign({},
							defParams,
							ex.request.params || {})
					}),
					method,
					ex.request,
					ex.response || {}
				));
			});
		});
	});

	return ret;

}


function cmp(result, expected, errMsg) {

	if (expected === null || expected === undefined) {
		// nothing to expect, so we can return
		return true;
	}
	if (result === null || result === undefined) {
		result = '';
	}

	if (expected.constructor === Object) {
		Object.keys(expected).forEach((key) => {
			const val = expected[key];
			assert.deepEqual({}.hasOwnProperty.call(result, key), true,
				`Body field ${key} not found in response!`);
			cmp(result[key], val, `${key} body field mismatch!`);
		});
		return true;
	} else if (expected.constructor === Array) {
		if (result.constructor !== Array) {
			assert.deepEqual(result, expected, errMsg);
			return true;
		}
		// only one item in expected - compare them all
		if (expected.length === 1 && result.length > 1) {
			result.forEach((item) => {
				cmp(item, expected[0], errMsg);
			});
			return true;
		}
		// more than one item expected, check them one by one
		if (expected.length !== result.length) {
			assert.deepEqual(result, expected, errMsg);
			return true;
		}
		expected.forEach((item, idx) => {
			cmp(result[idx], item, errMsg);
		});
		return true;
	}

	if (expected.length > 1 && expected[0] === '/' && expected[expected.length - 1] === '/') {
		if ((new RegExp(expected.slice(1, -1))).test(result)) {
			return true;
		}
	} else if (expected.length === 0 && result.length === 0) {
		return true;
	} else if (result === expected || result.startsWith(expected)) {
		return true;
	}

	assert.deepEqual(result, expected, errMsg);
	return true;

}


function validateTestResponse(testCase, res) {

	const expRes = testCase.response;

	// check the status
	assert.status(res, expRes.status);
	// check the headers
	Object.keys(expRes.headers).forEach((key) => {
		const val = expRes.headers[key];
		assert.deepEqual({}.hasOwnProperty.call(res.headers, key), true,
			`Header ${key} not found in response!`);
		cmp(res.headers[key], val, `${key} header mismatch!`);
	});
	// check the body
	if (!expRes.body) {
		return true;
	}
	res.body = res.body || '';
	if (Buffer.isBuffer(res.body)) {
		res.body = res.body.toString();
	}
	if (expRes.body.constructor !== res.body.constructor) {
		if (expRes.body.constructor === String) {
			res.body = JSON.stringify(res.body);
		} else {
			res.body = JSON.parse(res.body);
		}
	}
	// check that the body type is the same
	if (expRes.body.constructor !== res.body.constructor) {
		throw new Error(
			`Expected body type ${expRes.body.constructor} but got ${res.body.constructor}`
		);
	}

	// compare the bodies
	cmp(res.body, expRes.body, 'Body mismatch!');

	return true;

}


describe('Swagger spec', function() {

	// the variable holding the spec
	const spec = staticSpecLoad();
	// default params, if given
	let defParams = spec['x-default-params'] || {};

	this.timeout(20000);

	before(() => {
		return server.start();
	});

	it('get the spec', () => {
		return preq.get(`${server.config.uri}?spec`)
			.then((res) => {
				assert.status(200);
				assert.contentType(res, 'application/json');
				assert.notDeepEqual(res.body, undefined, 'No body received!');
				assert.deepEqual({ errors: [] }, validator.validate(res.body), 'Spec must have no validation errors');
			});
	});

	it('spec validation', () => {
		if (spec['x-default-params']) {
			defParams = spec['x-default-params'];
		}
		// check the high-level attributes
		['info', 'openapi', 'paths'].forEach((prop) => {
			assert.deepEqual(!!spec[prop], true, `No ${prop} field present!`);
		});
		// no paths - no love
		assert.deepEqual(!!Object.keys(spec.paths), true, 'No paths given in the spec!');
		// now check each path
		Object.keys(spec.paths).forEach((pathStr) => {
			assert.deepEqual(!!pathStr, true, 'A path cannot have a length of zero!');
			const path = spec.paths[pathStr];
			assert.deepEqual(!!Object.keys(path), true, `No methods defined for path: ${pathStr}`);
			Object.keys(path).forEach((method) => {
				const mSpec = path[method];
				if ({}.hasOwnProperty.call(mSpec, 'x-monitor') && !mSpec['x-monitor']) {
					return;
				}
				validateExamples(pathStr, defParams, mSpec['x-amples']);
			});
		});
	});

	describe('validate responses against schema', () => {
		const ajv = new Ajv({});

		const assertValidSchema = (uri, schemaPath) => {
			return preq.get({ uri })
				.then((res) => {
					if (!ajv.validate(schemaPath, res.body)) {
						throw new assert.AssertionError({ message: ajv.errorsText() });
					}
				});
		};

		Object.keys(spec.components.schemas).forEach((defName) => {
			ajv.addSchema(spec.components.schemas[defName], `#/components/schemas/${defName}`);
		});

		it('summary response should conform to schema', () => {
			const uri = `${baseUri}page/summary/Dubai/808803658`;
			return assertValidSchema(uri, '#/components/schemas/summary');
		});

		it('media-list response should conform to schema', () => {
			const uri = `${baseUri}page/media-list/Hummingbird`;
			return assertValidSchema(uri, '#/components/schemas/media_list');
		});

	});

	describe('validate spec examples', () => {

		constructTests(spec.paths, defParams).forEach((testCase) => {
			it(testCase.title, () => {
				return preq(testCase.request)
					.then((res) => {
						validateTestResponse(testCase, res);
					}, (err) => {
						validateTestResponse(testCase, err);
					});
			});
		});

	});
});

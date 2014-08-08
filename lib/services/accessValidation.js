/*
 * Copyright 2013 Telefonica Investigación y Desarrollo, S.A.U
 *
 * This file is part of fiware-orion-pep
 *
 * fiware-orion-pep is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * fiware-orion-pep is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with fiware-orion-pep.
 * If not, seehttp://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::[daniel.moranjimenez@telefonica.com]
 */

'use strict';

var request = require('request'),
    async = require('async'),
    apply = async.apply,
    config = require('../../config'),
    errors = require('../errors'),
    logger = require('fiware-node-logger'),
    mustache = require('mustache'),
    fs = require('fs'),
    sax = require('sax'),
    requestTemplate;

/**
 * Creates the XACML XML payload with the received parameters. To do so, it makes use of the mustache templates loaded
 * in the loadTemplates() method.
 *
 * @param {String} userToken             OAuth token identifiying the user.
 * @param {String} organization          Name of the organization with the frn format.
 * @param {String} action                Name of the action the request is trying to execute.
g */
function createAccessRequest(userToken, organization, action, callback) {
    var parameters = {
        organization: organization,
        subjectId: userToken,
        action: action
    };

    logger.debug('Creating access request for user [%s], with organization [%s] and action [%s]',
        userToken, organization, action);

    callback(null, mustache.render(requestTemplate, parameters));
}

/**
 * Sends the validation request to the Keystone proxy with the XML payload received.
 *
 * @param {String} accessPayload         XACML payload in string format.
 */
function sendAccessRequest(accessPayload, callback) {
    var options = {
        uri: config.access.protocol + '://' + config.access.host + ':' + config.access.port + config.access.path,
        method: 'POST',
        headers: {
            'Content-Type': 'application/xml',
            'Accept': 'application/xml'
        },
        body: accessPayload
    };

    logger.debug('Sending access request: \n%s\n', JSON.stringify(options, null, 4));

    request(options, function processResponse(error, response, body) {
        if (error) {
            logger.error('Error connecting to Keystone Proxy: %d', error.message);
            callback(new errors.KeystoneProxyConnectionError(error));
        } else if (response.statusCode !== 200) {
            logger.error('Wrong status received by Keystone Proxy: %d', response.statusCode);
            callback(new errors.KeystoneProxyValidationError('wrong status code received: ' + response.statusCode));
        } else {
            callback(null, body);
        }
    });
}

/**
 * Parse the response received from the Keystone proxy. This response is an XACML Response object, containing only a
 * single useful field, "DECISION", that contains the decision about the user validation. This function parse the XML
 * body and extracts the current decision.
 *
 * @param {String} body          Response body in text format.
 */
function parseResponse(body, callback) {
    var parser = sax.parser(true),
        readingDecision = false,
        decision;

    logger.debug('Parsing response body: \n%s\n', body);

    parser.onerror = function(e) {
        var error = new errors.WrongXmlPayload();

        logger.error('Error parsing validation response: %d', e.message);
        error.moreInfo = e;
        callback(error);
    };

    parser.ontext = function(t) {
        if (readingDecision) {
            if (!decision) {
                decision = t;
            } else {
                decision = decision + t;
            }
        }
    };

    parser.onopentag = function(node) {
        if (node.name.toUpperCase() === 'DECISION') {
            readingDecision = true;
        } else {
            readingDecision = false;
        }
    };

    parser.onend = function() {
        if (decision) {
            callback(null, decision.trim());
        } else {
            logger.error('Error reading validation response: decision not found');
            callback(new errors.WrongXmlPayload());
        }
    };

    parser.write(body).close();
}

/**
 * Decides what to do with the request depending on the decision taken by the Keystone Proxy.
 *
 * @param {String} decision         Decision received from the Keystone process
 */
function validate(decision, callback) {
    if (decision.toUpperCase() === 'PERMIT') {
        callback();
    } else {
        callback(new errors.AccessDenied());
    }
}

/**
 * Launches the validation process for the incoming request. As all the other middlewares in the proxy, it should chain
 * the received req and res to the next one in the callback invocation.
 *
 * @param {Object} req           Incoming request.
 * @param {Object} res           Outgoing response.
 * @param {Function} next        Call to the next middleware in the chain.
 */
function validationProcess(req, res, next) {
    async.waterfall([
        apply(createAccessRequest, req.userId, req.organization, req.action),
        sendAccessRequest,
        parseResponse,
        validate
    ], next);
}

/**
 *  Load the XML Templates for generating the validation requests. This method has to be called just once when the
 *  proxy has started, and the templates themselves are reused for every request.
 */
function loadTemplates(callback) {
    logger.debug('Loading access validation Templates');

    fs.readFile('./lib/templates/validationRequest.xml', 'utf8', function templateLoaded(error, templateData) {
        if (error) {
            logger.fatal('Validation Request templates not found');
            callback(errors.TemplateLoadingError(error));
        } else {
            requestTemplate = templateData;
            callback();
        }
    });
}

exports.validate = validationProcess;
exports.init = loadTemplates;
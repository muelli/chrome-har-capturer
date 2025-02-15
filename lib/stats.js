'use strict';

class Stats {
    constructor(url, options) {
        this._options = options;
        this._responseBodyCounter = 0;
        this.url = url;
        this.firstRequestId = undefined;
        this.firstRequestMs = undefined;
        this.requestContinuedMs = undefined;
        this.domContentEventFiredMs = undefined;
        this.loadEventFiredMs = undefined;
        this.entries = new Map();
        this.user = undefined; // filled from outside
    }

    processEvent(fulfill, reject, {method, params}) {
        const methodName = `_${method.replace('.', '_')}`;
        const handler = Stats.prototype[methodName];
        if (handler) {
            handler.call(this, fulfill, reject, params);
        }
    }

    isDone() {
        // a page is considered 'finished' when all these three messages
        // arrived: a reply to the first request, Page.domContentEventFired and
        // Page.loadEventFired; and if the reponse content is specified, when
        // all the response bodies are fetched

        // Important to note that this is the set of final exit conditions for a tag to be saved to the HAR
        // For future bugs related to tags being dropped, a good starting point will be to check which of these flags are undefined or false
        return this.firstRequestMs &&
            this.domContentEventFiredMs &&
            this.loadEventFiredMs &&
            (!this._options.content || this._responseBodyCounter === 0);
    }

    _checkFinished(fulfill) {
        if (this.isDone()) {
            fulfill();
        }
    }

    _Custom_requestContinued(fulfill, reject, params) {
        const {timestamp, requestId} = params;
        if (this.firstRequestId === requestId) {
            this.requestContinuedMs = timestamp * 1000;
        }
        const entry = this.entries.get(requestId);
        if (!entry) {
            return;
        }
        entry.requestContinuedS = timestamp;
    }

    _Page_domContentEventFired(fulfill, reject, params) {
        const {timestamp} = params;
        if (!this.domContentEventFiredMs) {
            this.domContentEventFiredMs = timestamp * 1000;
        }
        // check termination condition
        this._checkFinished(fulfill);
    }

    _Page_loadEventFired(fulfill, reject, params) {
        const {timestamp} = params;
        if (!this.loadEventFiredMs) {
            this.loadEventFiredMs = timestamp * 1000;
        }
        // check termination condition
        this._checkFinished(fulfill);
    }

    _Network_requestWillBeSent(fulfill, reject, params) {
        const {requestId, initiator, timestamp, redirectResponse} = params;
        // skip data URI
        if (params.request.url.match('^data:')) {
            return;
        }
        // the first is the first request
        if (!this.firstRequestId && initiator.type === 'other') {
            this.firstRequestMs = timestamp * 1000;
            this.firstRequestId = requestId;
        }
        // redirect responses are delivered along the next request
        if (redirectResponse) {
            const redirectEntry = this.entries.get(requestId);
            // craft a synthetic response params
            redirectEntry.responseParams = {
                response: redirectResponse
            };
            // set the redirect response finished when the redirect
            // request *will be sent* (this may be an approximation)
            redirectEntry.responseFinishedS = timestamp;
            redirectEntry.encodedResponseLength = redirectResponse.encodedDataLength;
            // since Chrome uses the same request id for all the
            // redirect requests, it is necessary to disambiguate
            const newId = requestId + '_redirect_' + timestamp;
            // rename the previous metadata entry
            this.entries.set(newId, redirectEntry);
            this.entries.delete(requestId);
        }
        // initialize this entry
        this.entries.set(requestId, {
            requestParams: params,
            responseParams: undefined,
            responseLength: 0, // built incrementally
            encodedResponseLength: undefined,
            responseFinishedS: undefined,
            responseBody: undefined,
            responseBodyIsBase64: undefined,
            newPriority: undefined
        });
        // check termination condition
        this._checkFinished(fulfill);
    }

    _Network_dataReceived(fulfill, reject, params) {
        const {requestId, dataLength} = params;
        const entry = this.entries.get(requestId);
        if (!entry) {
            return;
        }
        entry.responseLength += dataLength;
    }

    _Network_responseReceived(fulfill, reject, params) {
        const entry = this.entries.get(params.requestId);
        if (!entry) {
            return;
        }
        entry.responseParams = params;
        // HAR::parseEntry will drop an entry/network request if entry.responseFinishedS is falsy. The Stats::_Network_loadingFinished is the only place that sets the responseFinishedS, so
        // requests without the responseFinishedS defined will be dropped from the HAR, so requests without the loadingFinished are dropped.
        // We are setting the responseFinishedS with the request timestamp if the response finished successsfully with a 200 and we have a responseTime
        // forcing the requests to be included in the HAR.
        if (params.response.status === 200 && !!params.response.responseTime) {
            entry.responseFinishedS = params.timestamp;
        }
    }

    _Network_resourceChangedPriority(fulfill, reject, params) {
        const {requestId, newPriority} = params;
        const entry = this.entries.get(requestId);
        if (!entry) {
            return;
        }
        entry.newPriority = newPriority;
    }

    _Network_loadingFinished(fulfill, reject, params) {
        const {requestId, timestamp, encodedDataLength} = params;
        const entry = this.entries.get(requestId);
        if (!entry) {
            return;
        }
        entry.encodedResponseLength = encodedDataLength;
        entry.responseFinishedS = timestamp;
        // check termination condition
        this._responseBodyCounter++;
        this._checkFinished(fulfill);
    }

    _Network_loadingFailed(fulfill, reject, params) {
        const {requestId, errorText, canceled, timestamp} = params;
        const entry = this.entries.get(requestId);
        if (!entry) {
            return;
        }
        entry.responseFailedS = timestamp;
        // abort the whole page if the first request fails
        if (requestId === this.firstRequestId) {
            const message = errorText || canceled && 'Canceled';
            reject(new Error(message));
        }
    }

    _Network_getResponseBody(fulfill, reject, params) {
        const {requestId, body, base64Encoded} = params;
        const entry = this.entries.get(requestId);
        if (!entry) {
            return;
        }
        entry.responseBody = body;
        entry.responseBodyIsBase64 = base64Encoded;
        // check termination condition
        this._responseBodyCounter--;
        this._checkFinished(fulfill);
    }

    _Network_webSocketWillSendHandshakeRequest(fulfill, reject, params) {
        // initialize this entry (copied from requestWillbesent)
        this.entries.set(params.requestId, {
            isWebSocket: true,
            frames: [],
            requestParams: params,
            responseParams: undefined,
            responseLength: 0, // built incrementally
            encodedResponseLength: undefined,
            responseFinishedS: undefined,
            responseBody: undefined,
            responseBodyIsBase64: undefined,
            newPriority: undefined
        });
    }

    _Network_webSocketHandshakeResponseReceived(fulfill, reject, params) {
        // reuse the general handler
        this._Network_responseReceived(fulfill, reject, params);
    }

    _Network_webSocketClosed(fulfill, reject, params) {
        const {requestId, timestamp} = params;
        const entry = this.entries.get(requestId);
        if (!entry) {
            return;
        }
        // XXX keep track of the whole WebSocket session duration, failure to
        // receive this message though must not discard the entry since the page
        // loading event may happen well before the actual WebSocket termination
        entry.responseFinishedS = timestamp;
    }

    _Network_webSocketFrameSent(fulfill, reject, params) {
        const {requestId, timestamp, response} = params;
        const entry = this.entries.get(requestId);
        if (!entry) {
            return;
        }
        entry.frames.push({
            type: 'send',
            time: timestamp,
            opcode: response.opcode,
            data: response.payloadData
        });
    }

    _Network_webSocketFrameReceived(fulfill, reject, params) {
        const {requestId, timestamp, response} = params;
        const entry = this.entries.get(requestId);
        if (!entry) {
            return;
        }
        entry.frames.push({
            type: 'receive',
            time: timestamp,
            opcode: response.opcode,
            data: response.payloadData
        });
    }
}

module.exports = Stats;

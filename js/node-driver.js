#!/usr/bin/env node

'use strict';

//prebaked script to load uber data
//similar to main.js


var Q = require("q"),
    Rx = require("rx"),
    _ = require('underscore'),

    request = require('request'),
    debug = require("debug")("graphistry:graph-viz:node-driver"),

    NBody = require("./NBody.js"),
    RenderNull = require('./RenderNull.js'),
    SimCL = require("./SimCL.js"),

    metrics = require("./metrics.js"),
    loader = require("./data-loader.js");

metrics.init('StreamGL:driver');

var WIDTH = 600,
    HEIGHT = 600;

var SIMULATION_TIME = 3000; //seconds
var dimensions = [1,1];


function applyControls(graph, cfgName) {
    var controls = require('./layout.config.js');
    var cfg = cfgName ? controls.cfgName : controls.default;

    debug("Applying layout settings: %o", cfg);

    var simulator = cfg.simulator || SimCL
    var algoEntries = cfg.layoutAlgorithms || [];
    var layoutAlgorithms = []

    for (var i = 0; i < algoEntries.length; i++) {
        var entry = algoEntries[i];
        var params = entry.params || {}
        entry.algo.setPhysics(params)
        layoutAlgorithms.push(entry.algo);
    }

    var lockCtrl = cfg.locks || controls.default.lockCtrl;
    return graph.initSimulation(simulator, layoutAlgorithms, lockCtrl)
        .then(function (graph) {
            var renderingCtrl = cfg.rendering || controls.default.renderingCtrl;
            graph.setVisible(renderingCtrl);
            return graph;
        });
}


function getBufferVersion (graph, bufferName) {
    var deviceBuffers = ["curPoints", "springsPos", "midSpringsPos", "curMidPoints", "midSpringsColorCoord"];
    var localBuffers = ['pointSizes', 'pointColors', 'edgeColors'];

    if (deviceBuffers.indexOf(bufferName) > -1) {
        return graph.simulator.versions.buffers[bufferName];
    } else if (localBuffers.indexOf(bufferName) > -1) {
        return graph.simulator.versions.buffers[bufferName];
    } else {
        throw new Error("could not find buffer", bufferName);
    }
}



function graphCounts(graph) {

    if (graph.simulator.postSlider) {
        var numPoints = graph.simulator.timeSubset.pointsRange.len;
        var numEdges = graph.simulator.timeSubset.edgeRange.len;
    } else {
        var numPoints = graph.simulator.numPoints;
        var numEdges = graph.simulator.numEdges;
    }

    var numMidPoints =
        Math.round((numPoints / graph.renderer.numPoints) * graph.renderer.numMidPoints);
    var numMidEdges =
        Math.round((numEdges / graph.renderer.numEdges) * graph.renderer.numMidEdges);

    return {
        numPoints: numPoints,
        numEdges: numEdges,
        numMidPoints: numMidPoints,
        numMidEdges: numMidEdges,
        midSpringsColorCoord: 0
    };
}

// ... -> {<name>: {buffer: ArrayBuffer, version: int}}
function fetchVBOs(graph, bufferNames) {

    var targetArrays = {};

    // TODO: Reuse existing ArrayBuffers once we're sure we're sure it's safe to do so (we've
    // written the CL data to it, and written it to the socket sent to the client.)
    var buffersToFetch =
        ["curPoints", "springsPos", "midSpringsPos", "curMidPoints", "midSpringsColorCoord"]
        .filter(function (name) {
            return bufferNames.indexOf(name) != -1;
        });

    var bufferToModel = {
        curPoints: ['numPoints', 0 * Float32Array.BYTES_PER_ELEMENT],
        springsPos: ['numEdges', 2 * 2 * Float32Array.BYTES_PER_ELEMENT],
        midSpringsPos: ['numMidEdges', 2 * 2 * Float32Array.BYTES_PER_ELEMENT],
        curMidPoints: ['curMidPoints', 2 * Float32Array.BYTES_PER_ELEMENT],
        midSpringsColorCoord: ['midSpringsColorCoord', 0],
        pointSizes: ['numPoints', 1 * Float32Array.BYTES_PER_ELEMENT],
        pointColors: ['numPoints', 1 * Float32Array.BYTES_PER_ELEMENT],
        edgeColors: ['numEdges', 1 * Float32Array.BYTES_PER_ELEMENT]
    };

    var bufferSizes = fetchBufferByteLengths(graph);
    var counts = graphCounts(graph);

    // TODO: Instead of doing blocking CL reads, use CL events and wait on those.
    // node-webcl's event arguments to enqueue commands seems busted at the moment, but
    // maybe enqueueing a event barrier and using its event might work?
    return Q.all(
        buffersToFetch.map(function(name) {
            targetArrays[name] = {
                buffer: new ArrayBuffer(bufferSizes[name]),
                version: graph.simulator.versions.buffers[name]
            };

            if (graph.simulator.postSlider) {
                var modelName = bufferToModel[name][0];
                var stride = bufferToModel[name][1];
                return graph.simulator.buffers[name].read(
                    new Float32Array(targetArrays[name].buffer),
                    counts[modelName] * stride);
            } else {
                return graph.simulator.buffers[name].read(
                    new Float32Array(targetArrays[name].buffer)
                )
            }
    }))
    .then(function() {
        var localBuffers = {
            'pointSizes': graph.simulator.buffersLocal.pointSizes.buffer,
            'pointColors': graph.simulator.buffersLocal.pointColors.buffer,
            'edgeColors': graph.simulator.buffersLocal.edgeColors.buffer
        };
        for (var i in localBuffers) {
            if (bufferNames.indexOf(i) != -1) {
                targetArrays[i] = {
                    buffer: localBuffers[i],
                    version: graph.simulator.versions.buffers[i]
                };
            }
        }

        return targetArrays;
    });
}



function fetchNumElements(graph) {

    var counts = graphCounts(graph);

    return {
        edges:              counts.numEdges * 2,
        edgeculled:         counts.numEdges * 2,
        midedges:           counts.numMidEdges * 2,
        midedgeculled:      counts.numMidEdges * 2,
        midedgetextured:    counts.numMidEdges * 2,
        points:             counts.numPoints,
        pointculled:        counts.numPoints,
        pointpicking:       counts.numPoints,
        pointpickingScreen: counts.numPoints,
        pointsampling:      counts.numPoints,
        midpoints:          counts.numMidPoints
    };
}
function fetchBufferByteLengths(graph) {


    var counts = graphCounts(graph);

    //FIXME generate from renderConfig
    //form: elements * ?dimensions * points * BYTES_PER_ELEMENT
    return {
        springsPos:             counts.numEdges * 2 * 2 * Float32Array.BYTES_PER_ELEMENT,
        curPoints:              counts.numPoints * 2 * Float32Array.BYTES_PER_ELEMENT,
        pointSizes:             counts.numPoints * Uint8Array.BYTES_PER_ELEMENT,
        pointColors:            counts.numPoints * 4 * Uint8Array.BYTES_PER_ELEMENT,
        edgeColors:             counts.numEdges * 2 * 4 * Uint8Array.BYTES_PER_ELEMENT,
        curMidPoints:           counts.numMidPoints * 2 * Float32Array.BYTES_PER_ELEMENT,
        midSpringsPos:          counts.numMidEdges * 2 * 2 * Float32Array.BYTES_PER_ELEMENT,
        midSpringsColorCoord:   counts.numMidEdges * 2 * 2 * Float32Array.BYTES_PER_ELEMENT
    };
}


function init() {
    debug("Running Naive N-body simulation");
    console.log("Running Naive N-body simulation");

    var document = null;
    var canvasStandin = {
        width: WIDTH,
        height: HEIGHT,
        clientWidth: WIDTH,
        clientHeight: HEIGHT
    };

    return NBody.create(RenderNull, document, canvasStandin, [255,255,255,1.0], dimensions, 3);
}


/**
 * Returns an Observable that fires an event in `delay` ms, with the given `value`
 * @param  {number}   [delay=16]    - the time, in milliseconds, before the event is fired
 * @param  {*}        [value=false] - the value of the event (`delay` must be given if `value` is)
 * @return {Rx.Observable} A Rx Observable stream that emits `value` after `delay`, and finishes
 */
function delayObservableGenerator(delay, value, cb) {
    if(arguments.length < 2) {
        cb = arguments[0];
        delay = 16;
        value = false;
    } else if(arguments.length < 3) {
        cb = arguments[1];
        value = false;
    }

    return Rx.Observable.return(value)
        .delay(delay)
        .flatMap(function(v1) {
            return Rx.Observable.fromNodeCallback(function(v2, cb) {
                setImmediate(function() { cb(v2); });
            })(v1);
        });
};


///////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////


function createAnimation(config) {
    debug("STARTING DRIVER");

    var userInteractions = new Rx.Subject();

    // This signal is emitted whenever the renderer's VBOs change, and contains Typed Arraysn for
    // the contents of each VBO
    var animStepSubj = new Rx.BehaviorSubject(null);

    //animStepSubj.subscribe(function () {
    //    debug("NOTIFYING OF BIG STEP")
    //})

    var dataConfig = {
        'listURI': config.DATALISTURI, 
        'name': config.DATASETNAME, 
        'idx': config.DATASETIDX
    }

    var theDataset = loader.getDataset(dataConfig);
    var theGraph = init();

    Q.all([theGraph, theDataset]).spread(function (graph, dataset) {
        debug("Dataset %o", dataset);
        return Q.all([
            applyControls(graph, dataset.config['simControls']),
            dataset
        ]);
    }).spread(function (graph, dataset) {
        userInteractions.subscribe(function (settings){
            debug('Updating settings..');
            graph.updateSettings(settings);
        })

        debug("LOADING DATASET");
        return loader.loadDatasetIntoSim(graph, dataset) 
    }).then(function (graph) {
        debug("ANIMATING");

        var isRunning =
            Rx.Observable.merge(
                //run beginning & after every interaction
                userInteractions.merge(Rx.Observable.return())
                    .map(_.constant(true)),
                //...  but stop a bit after last one
                userInteractions.merge(Rx.Observable.return())
                    .throttle(SIMULATION_TIME).map(_.constant(false)));

        var isRunningRecent = new Rx.ReplaySubject(1);

        isRunningRecent.subscribe(function (v) {
            debug('=============================isRunningRecent:', v)
        });

        isRunning.subscribe(isRunningRecent);

        // Loop simulation by recursively expanding each tick event into a new sequence
        // Gate by isRunning
        Rx.Observable.fromPromise(graph.tick())
            .expand(function() {
                var now = Date.now();
                //return (Rx.Observable.fromCallback(graph.renderer.document.requestAnimationFrame))()
                return Rx.Observable.return()
                    // Add in a delay to allow nodejs' event loop some breathing room
                    .flatMap(function() {
                        return delayObservableGenerator(16, false);
                    })
                    .flatMap(function () {
                        return isRunningRecent.filter(_.identity).take(1);
                    })
                    .flatMap(function(v) {
                        //debug('step..')
                        return (Rx.Observable.fromPromise(
                            graph
                                .tick()
                                .then(function () {
                                    //debug('ticked');
                                    metrics.info({metric: {'tick_durationMS': Date.now() - now} });
                                })
                        ));
                    })
                    .map(_.constant(graph));
            })
            .subscribe(animStepSubj);

    })
    .then(function (graph) {
        debug("Graph created");
    }, function (err) {
        console.error("\n\n~~~~~ SETUP ERROR\n", err, ". Stack:", err.stack);
        console.error("\n\nEXITING\n\n");
        process.exit(-1);
    })
    .done();

    return {
        proxy: function (settings) {
            userInteractions.onNext(settings);
        },
        ticks: animStepSubj.skip(1)
    }
}


/**
 * Fetches compressed VBO data and # of elements for active buffers and programs
 * @returns {Rx.Observable} an observable sequence containing one item, an Object with the 'buffers'
 * property set to an Object mapping buffer names to ArrayBuffer data; and the 'elements' Object
 * mapping render item names to number of elements that should be rendered for the given buffers.
 */
function fetchData(graph, compress, bufferNames, bufferVersions, programNames) {

    bufferVersions = bufferVersions || _.object(bufferNames.map(function (name) { return [name, -1]}));

    var neededBuffers =
        bufferNames.filter(function (name) {
            var clientVersion = bufferVersions[name];
            var liveVersion = getBufferVersion(graph, name);
            return clientVersion < liveVersion;
        });
    bufferNames = neededBuffers;

    var now = Date.now();
    return Rx.Observable.fromPromise(fetchVBOs(graph, bufferNames))
        .flatMap(function (vbos) {
            //metrics.info({metric: {'fetchVBOs_lastVersions': bufferVersions}});
            metrics.info({metric: {'fetchVBOs_buffers': bufferNames}});
            metrics.info({metric: {'fetchVBOs_durationMS': Date.now() - now}});

            bufferNames.forEach(function (bufferName) {
                if (!vbos.hasOwnProperty(bufferName)) {
                    throw new Error('vbos does not have buffer', bufferName);
                }
            })

            //[ {buffer, version, compressed} ] ordered by bufferName
            var now = Date.now();
            var compressed =
                bufferNames.map(function (bufferName) {
                    var now = Date.now();
                    return Rx.Observable.fromNodeCallback(compress.deflate)(
                        vbos[bufferName].buffer,//binary,
                        {output: new Buffer(
                            Math.max(1024, Math.round(vbos[bufferName].buffer.byteLength * 1.5)))})
                        .map(function (compressed) {
                            debug('compress bufferName', bufferName);
                            metrics.info({metric: {'compress_buffer': bufferName} });
                            metrics.info({metric: {'compress_inputBytes': vbos[bufferName].buffer.byteLength} });
                            metrics.info({metric: {'compress_outputBytes': compressed.length} });
                            metrics.info({metric: {'compress_durationMS': Date.now() - now} });
                            return _.extend({}, vbos[bufferName], {compressed: compressed});
                        })
                });

            return Rx.Observable.zipArray(compressed).take(1)
                .do(function () { metrics.info({metric: {'compressAll_durationMS': Date.now() - now} }) });

        })
        .map(function(compressedVbos) {

            var buffers =
                _.object(_.zip(
                        bufferNames,
                        bufferNames.map(function (_, i) {  return compressedVbos[i].compressed[0]; })));

            var versions =
                _.object(_.zip(
                        bufferNames,
                        bufferNames.map(function (_, i) {  return compressedVbos[i].version; })));

            return {
                compressed: buffers,
                elements: _.pick(fetchNumElements(graph), programNames),
                bufferByteLengths: _.pick(fetchBufferByteLengths(graph), bufferNames),
                versions: versions
            };

        });
}



exports.create = createAnimation;
exports.fetchData = fetchData;


// If the user invoked this script directly from the terminal, run init()
if(require.main === module) {
    var config  = require('./config.js')();
    var vbosUpdated = createAnimation(config);

    vbosUpdated.subscribe(function() { debug("Got updated VBOs"); } );
}

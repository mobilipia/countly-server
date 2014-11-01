'use strict';

var _               = require('underscore'),
    common 			= require('./../../utils/common.js'),
	pushly 			= require('pushly')(),
    mess            = require('./message.js'),
    cluster			= require('cluster'),
    Message         = mess.Message,
    MessageStatus   = mess.MessageStatus;

var check = function() {
	common.db.collection('messages').findAndModify(
		{date: {$lt: new Date()}, 'result.status': MessageStatus.Initial, 'deleted': {$exists: false}}, 
		[['date', 1]],
		{$set: {'result.status': MessageStatus.InProcessing}}, 
		{'new': true},

		function(err, message){
			if (message) {
				message = new Message(message);
				var conditions = message.getUserCollectionConditions(), toPush = [];

                // pushly submessages
				message.pushly = [];

				common.db.collection('apps').find({_id: {$in: message.apps}}).toArray(function(err, apps){
					if (apps) for (var m = message.apps.length - 1; m >= 0; m--) {
						var appId = message.apps[m],
							app;

						for (var k in apps) if (apps[k]._id.toString() === appId.toString()) app = apps[k];

						if (app) {
                            // query used to get device tokens when message gets to the top of queue
							var query = {appId: appId, conditions: conditions},
								credentials = require('./endpoints.js').credentials(message, app);

                            if (credentials.length === 0) {
                                // no device credentials is provided for all app-platform-(test or not) combinations
                                common.db.collection('messages').update({_id: message._id}, {$set: {
                                    result: {
                                        status: MessageStatus.Aborted | MessageStatus.Error,
                                        error: 'No credentials provided'
                                    }}});
                            } else {
                                for (var c = credentials.length - 1; c >= 0; c--) {
                                    var creds = credentials[c];

                                    var field = creds.id.split('.')[0],
                                        match = _.extend({}, conditions);
                                    match[common.dbUserMap.tokens + '.' + field] = {$exists: true};

                                    // count first to prevent no users errors within some of app-platform combinations
                                    // of the message which will turn message status to error
                                    common.db.collection('app_users' + app._id).count(match, function(err, count){
                                        if (count) {
                                            var msg = message.toPushly(creds, query, [appId, creds.id]);
                                            
                                            common.db.collection('messages').update(
                                                {_id: message._id}, 
                                                {
                                                    $addToSet: {pushly: {id: msg.id, query: query, result: msg.result}}, 
                                                    $set: {'result.status': MessageStatus.InQueue}
                                                }
                                            );

                                            pushly.push(msg);
                                        }
                                    });

                                    // // pushly messages to send
                                    // toPush.push(msg);

                                    // // submessages for Countly message object in DB
                                    // message.pushly.push({id: msg.id, query: query, result: msg.result});
                                }
                            }
						} else {
                            console.log('!!!!!!!!!!!!! App not found in findAndModify !!!');
                        }
					}

                    // if (message.pushly.length) {
                        // common.db.collection('messages').update({_id: message._id}, {$set: {pushly: message.pushly, 'result.status': MessageStatus.InQueue}});
                        // toPush.forEach(pushly.push.bind(pushly));
                    // }
				});
            }
		}
	);
};

var launched = false;

var periodicCheck = function(){
	if (cluster.isMaster) {
        if (!launched) {
            setTimeout(function(){  // wait for app to start
                common.db.collection('messages').update({'result.status': {$in: [MessageStatus.InProcessing]}}, {$set: {'result.status': MessageStatus.Initial}}, function(){
                    launched = true;
                    check();
                    setTimeout(periodicCheck, 3000);
                });
            }, 5000);
        } else {
            check();
            setTimeout(periodicCheck, 3000);
        }
	}
};

module.exports = periodicCheck;

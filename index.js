var async = require('async');
var _ = require('underscore');
var oracle = require('oracle');
var sql = require('./lib/sql.js');
var Query = require('./lib/query');
var utils = require('./utils');
_.str = require('underscore.string');
var Sequel = require('waterline-sequel');
var Processor = require('./lib/processor');
var Cursor = require('waterline-cursor');
var hop = utils.object.hasOwnProperty;
var SqlString = require('./lib/SqlString');
var Errors = require('waterline-errors').adapter;
var Pool = require('generic-pool');

var LOG_QUERIES = false;

module.exports = (function() {


    //var dbs = {};
    var connections = {};


    var sqlOptions = {
        parameterized: false,
        caseSensitive: false,
        escapeCharacter: '"',
        casting: false,
        canReturnValues: false,
        escapeInserts: true,
        declareDeleteAlias: false,
        explicitTableAs: false,
        prefixAlias: 'alias__',
        stringDelimiter: "'",
        rownum: true
    };

    var adapter = {
        autoIncrements: [],
        autoIncNextval: function(tableName, columnName) {
            this.autoIncrements[tableName] = this.autoIncrements[tableName] || [];
            this.autoIncrements[tableName][columnName] = this.autoIncrements[tableName][columnName] || 1;
            var nextval = this.autoIncrements[tableName][columnName] + 1;
            this.autoIncrements[tableName][columnName] = nextval;
            return nextval;
        },
        // Set to true if this adapter supports (or requires) things like data types, validations, keys, etc.
        // If true, the schema for models using this adapter will be automatically synced when the server starts.
        // Not terribly relevant if not using a non-SQL / non-schema-ed data store
        syncable: true,
        // Including a commitLog config enables transactions in this adapter
        // Please note that these are not ACID-compliant transactions:
        // They guarantee *ISOLATION*, and use a configurable persistent store, so they are *DURABLE* in the face of server crashes.
        // However there is no scheduled task that rebuild state from a mid-step commit log at server start, so they're not CONSISTENT yet.
        // and there is still lots of work to do as far as making them ATOMIC (they're not undoable right now)
        //
        // However, for the immediate future, they do a great job of preventing race conditions, and are
        // better than a naive solution.  They add the most value in findOrCreate() and createEach().
        //
        // commitLog: {
        //  identity: '__default_mongo_transaction',
        //  adapter: 'sails-mongo'
        // },

        // Default configuration for collections
        // (same effect as if these properties were included at the top level of the model definitions)
        defaults: {
            // For example:
            // port: 3306,
            // host: 'localhost'
            tns: '',
            user: '',
            password: '',
            // If setting syncable, you should consider the migrate option,
            // which allows you to set how the sync will be performed.
            // It can be overridden globally in an app (config/adapters.js) and on a per-model basis.
            //
            // drop   => Drop schema and data, then recreate it
            // alter  => Drop/add columns as necessary, but try
            // safe   => Don't change anything (good for production DBs)
            migrate: 'safe'
        },
        config: {
        },
        // This method runs when a model is initially registered at server start time
        // registerCollection: function(collection, cb) {

        //     var def = _.clone(collection);
        //     var key = def.identity;
        //     var definition = def.definition || {};

        //     // Set a default Primary Key
        //     var pkName = 'id';

        //     // Set the Primary Key Field
        //     for (var attribute in definition) {
        //         if (!definition[attribute].hasOwnProperty('primaryKey'))
        //             continue;

        //         // Check if custom primaryKey value is falsy
        //         if (!definition[attribute].primaryKey)
        //             continue;

        //         // Set the pkName to the custom primaryKey value
        //         pkName = attribute;
        //     }
        //     // Set the primaryKey on the definition object
        //     def.primaryKey = pkName;


        //     // Store the definition for the model identity
        //     if (dbs[key])
        //         return cb();
        //     dbs[key.toString()] = def;


        //     return cb();
        // },
        //added to match waterline orm
        registerConnection: function(connection, collections, cb) {
            console.log("Registring connections pool " + connection.identity + "...");

            if (!connection.identity)
                return cb("Errors.IdentityMissing");
            if (connections[connection.identity])
                return cb("Errors.IdentityDuplicate");

            var pool = Pool.Pool({
                name: connection.identity,
                create: function(callback) {
                    oracle.connect(marshalConfig(connection), function(err, cnx) {
                        if (err) {
                            return callback(err, null);
                        }
                        var queries = [];
                        queries[0] = "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'yyyy-mm-dd hh24:mi:ss'";
                        queries[1] = "ALTER SESSION SET NLS_DATE_FORMAT = 'yyyy-mm-dd hh24:mi:ss'";
                        queries[2] = "ALTER SESSION SET NLS_COMP=LINGUISTIC";
                        queries[3] = "ALTER SESSION SET NLS_SORT=BINARY_CI";
                        async.eachSeries(queries, function(query, end) {
                            //execute all init queries
                            cnx.execute(query, [], function(err, results) {
                                if (err) {
                                    return callback(err, null);
                                }
                                end();
                            });
                        }, function(err) {
                            if (err) {
                                return callback(err, null);
                            }
                            //all queries passed ok so return oracle connection to pool
                            callback(null, cnx);
                        });
                    });
                },
                destroy: function(cnx){
                    cnx.close();
                },
                min: 5,
                max: 20,
                idleTimeoutMillis : 30000,
                log: false
            });

            // Store the connection
            connections[connection.identity] = {
                config: connection,
                collections: collections,
                connection: pool
            };

            return cb();
        },
        //endd add
        // The following methods are optional
        ////////////////////////////////////////////////////////////

        // Optional hook fired when a model is unregistered, typically at server halt
        // useful for tearing down remaining open connections, etc.
        teardown: function(connectionName, cb) {
            console.log("closing connections pool " + connectionName);
            var pool = connections[connectionName].connection;
            pool.drain(function() {
                pool.destroyAllNow();
            });
            return cb();
        },
        // REQUIRED method if integrating with a schemaful database
        define: function(connectionName, collectionName, definition, cb, connection) {


            // Define a new "table" or "collection" schema in the data store
            var self = this;
            console.log("Defining model '" + collectionName + "' ...");

            if (_.isUndefined(connection)) {
                return spawnConnection(__DEFINE__, connections[connectionName], cb);
            } else {
                __DEFINE__(connection, cb);
            }

            function __DEFINE__(connection, cb) {

                var connectionObject = connections[connectionName];
                var collection = connectionObject.collections[collectionName];
                if (!collection) {
                    return cb(util.format('Unknown collection `%s` in connection `%s`', collectionName, connectionName));
                }

                var tableName = collectionName;

                var schema = sql.schema(tableName, definition);

                // Build query
                var query = 'CREATE TABLE "' + tableName + '" (' + schema + ')';

                if (connectionObject.config.charset) {
                    query += ' DEFAULT CHARSET ' + connectionObject.config.charset;
                }

                if (connectionObject.config.collation) {
                    if (!connectionObject.config.charset)
                        query += ' DEFAULT ';
                    query += ' COLLATE ' + connectionObject.config.collation;
                }


                // Run query
                if (LOG_QUERIES) {
                    console.log('\nExecuting Oracle query: ', query);
                }

                console.log(query);
                connection.execute(query, [], function __DEFINE__(err, result) {
                    if (err) {
                        console.log(err);
                        return cb(err);
                    }
                    console.log("Table " + tableName + " created.");
                    // creation des sequence pour les champs autoIncrement
                    Object.keys(definition).forEach(function(columnName) {
                        var column = definition[columnName];
                        if (fieldIsAutoIncrement(column)) {
                            //init autoIncrement values
                            self.autoIncrements[tableName] = self.autoIncrements[tableName] || [];
                            self.autoIncrements[tableName][columnName] = 1;
                            var autoIncrementQuery = 'SELECT MAX("' + columnName + '") AS MAX FROM "' + tableName + '"';
                            connection.execute(autoIncrementQuery, [], function(err, autoInc) {
                                if (err) {
                                    console.log("could not get last autoIncrement value");
                                    return;
                                }
                                self.autoIncrements[tableName][columnName] = autoInc[0]['MAX'] || 1;
                            });
                        }
                    });
                    //
                    // TODO:
                    // Determine if this can safely be changed to the `adapter` closure var
                    // (i.e. this is the last remaining usage of the "this" context in the MySQLAdapter)
                    //

                    self.describe(connectionName, collectionName, function(err) {
                        cb(err, result);
                    });
                });


            }
        },
        // REQUIRED method if integrating with a schemaful database
        /* describe: function(collectionName, cb) {

         // Respond with the schema (attributes) for a collection or table in the data store
         var attributes = {};
         cb(null, attributes);
         },*/
        describe: function(connectionName, collectionName, cb, connection) {
            console.log('Describing \'' + collectionName + '\' ...');

            if (_.isUndefined(connection)) {
                return spawnConnection(__DESCRIBE__, connections[connectionName], cb);
            } else {

                __DESCRIBE__(connection, cb);
            }

            function __DESCRIBE__(connection, cb) {
                var connectionObject = connections[connectionName];
                var collection = connectionObject.collections[collectionName];

                if (!collection) {
                    return cb(util.format('Unknown collection `%s` in connection `%s`', collectionName, connectionName));
                }

                var tableName = collectionName;

                var queries = [];
                queries[0] = "SELECT COLUMN_NAME, DATA_TYPE, NULLABLE FROM USER_TAB_COLUMNS WHERE TABLE_NAME = '" + tableName + "'";
                queries[1] = "SELECT index_name,COLUMN_NAME FROM user_ind_columns WHERE table_name = '" + tableName + "'";
                queries[2] = "SELECT cols.table_name, cols.column_name, cols.position, cons.status, cons.owner "
                        + "FROM all_constraints cons, all_cons_columns cols WHERE cols.table_name = '" + tableName
                        + "' AND cons.constraint_type = 'P' AND cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner "
                        + "ORDER BY cols.table_name, cols.position";

                async.mapSeries(queries, function(query, callback) {
                    connection.execute(query, [], callback);
                }, function(err, results) {
                    if (err) {
                        console.log(err);
                        return cb(err);
                    }
                    var schema = results[0];
                    var indexes = results[1];
                    var tablePrimaryKeys = results[2];

                    if (schema.length === 0) {
                        console.log('Table \'' + collectionName + '\' doesn\'t exist, creating it ...');
                        return cb();
                    }

                    // Loop through Schema and attach extra attributes
                    schema.forEach(function(attribute) {
                        tablePrimaryKeys.forEach(function(pk) {
                            // Set Primary Key Attribute
                            if (attribute.COLUMN_NAME === pk.COLUMN_NAME) {
                                attribute.primaryKey = true;
                                // If also a number set auto increment attribute
                                if (attribute.DATA_TYPE === 'NUMBER') {
                                    attribute.autoIncrement = true;
                                }
                            }
                        });
                        // Set Unique Attribute
                        if (attribute.NULLABLE === 'N') {
                            attribute.required = true;
                        }

                    });
                    // Loop Through Indexes and Add Properties
                    indexes.forEach(function(index) {
                        schema.forEach(function(attribute) {
                            if (attribute.COLUMN_NAME === index.COLUMN_NAME)
                            {
                                attribute.indexed = true;
                            }
                        });
                    });
                    // Convert mysql format to standard javascript object

                    var normalizedSchema = sql.normalizeSchema(schema, collection.attributes);
                    // Set Internal Schema Mapping
                    collection.schema = normalizedSchema;
                    console.log('Table \'' + collectionName + '\' described.');
                    // TODO: check that what was returned actually matches the cache
                    cb(null, normalizedSchema);
                });
            }
        },
        // Direct access to query
        query: function(connectionName, collectionName, query, data, cb, connection) {

            if (_.isFunction(data)) {
                cb = data;
                data = null;
            }

            if (_.isUndefined(connection)) {
                return spawnConnection(__QUERY__, connections[connectionName], cb);
            } else {
                __QUERY__(connection, cb);
            }

            function __QUERY__(connection, cb) {
                console.log('Executing query: ' + query);
                data = data || [];
                // Run query
                connection.execute(query, data, function(err, result) {
                    if (err) {
                        console.log("#Error executing QUERY " + err.toString() + ".");
                        return cb(handleQueryError(err));
                    }
                    return cb(null, result);
                });
            }
        },
        // REQUIRED method if integrating with a schemaful database
        drop: function(connectionName, collectionName, relations, cb, connection) {
            // Drop a "table" or "collection" schema from the data store
            var self = this;

            if (typeof relations === 'function') {
                cb = relations;
                relations = [];
            }

            if (_.isUndefined(connection)) {
                return spawnConnection(__DROP__, connections[connectionName], cb);
            } else {
                __DROP__(connection, cb);
            }

            function __DROP__(connection, cb) {

                var connectionObject = connections[connectionName];

                // Drop any relations
                function dropTable(item, next) {
                    var tableName = collectionName;

                    // Build query
                    var query = 'DROP TABLE "' + tableName + '"';

                    // Run query
                    console.log('Executing : ' + query);
                    connection.execute(query, [], function __DROP__(err, result) {
                        if (err) {
                            console.log("#Error executing DROP " + err.toString() + ".");
                            if (err.code !== 'ER_BAD_TABLE_ERROR' && err.code !== 'ER_NO_SUCH_TABLE')
                                return next(err);
                            result = null;
                        }
                        if (result) {
                            console.log('Table \'' + collectionName + '\' dropped.');
                            self.autoIncrements[tableName] = [];
                        }
                        next(null, result);
                    });
                }

                async.eachSeries(relations, dropTable, function(err) {
                    if (err)
                        return cb(err);
                    dropTable(collectionName, cb);
                });
            }
        },
        // Optional override of built-in alter logic
        // Can be simulated with describe(), define(), and drop(),
        // but will probably be made much more efficient by an override here
        // alter: function (collectionName, attributes, cb) {
        // Modify the schema of a table or collection in the data store
        // cb();
        // },


        // REQUIRED method if users expect to call Model.create() or any methods
        create: function(connectionName, collectionName, data, cb, connection) {
            var self = this;
            var connectionObject = connections[connectionName];
            var collection = connectionObject.collections[collectionName];
            var tableName = collectionName;

            //var _insertData = lodash.cloneDeep(data);
            var _insertData = _.clone(data);

            // Prepare values
            Object.keys(data).forEach(function(value) {
                data[value] = utils.prepareValue(data[value]);
            });
            //recherche des champs incrémentals et de type date et affectation des valeurs lues des séquences
            var pk = null;
            var autoIncPK = null;
            var autoIncPKval = null;

            var definition = collection.definition;
            Object.keys(definition).forEach(function(columnName) {
                var column = definition[columnName];

                if (fieldIsAutoIncrement(column)) {
                    data[columnName] = self.autoIncNextval(tableName, columnName);
                    if (column.hasOwnProperty('primaryKey')) {
                        autoIncPK = columnName;
                        autoIncPKval = self.autoIncrements[tableName][columnName];
                    }
                }
                //si le  champs est de type date time
                if (fieldIsDatetime(column)) {
                    data[columnName] = _.isUndefined(data[columnName]) ? 'null' : SqlString.dateField(data[columnName]);
                }
                else if (fieldIsBoolean(column)) {
                    data[columnName] = (data[columnName]) ? 1 : 0;
                }
                else if (column.hasOwnProperty('primaryKey')) {
                    pk = columnName;
                }
            });
            //fin recherche
            var schema = collection.waterline.schema;
            var _query;

            var sequel = new Sequel(schema, sqlOptions);

            // Build a query for the specific query strategy
            try {
                _query = sequel.create(collectionName, data);
            } catch (e) {
                return cb(e);
            }

            if (_.isUndefined(connection)) {
                return spawnConnection(__QUERY__, connections[connectionName], cb);
            } else {
                __QUERY__(connection, cb);
            }

            function __QUERY__(connection, cb) {

                // Run query
                console.log('Executing : ' + _query.query);
                connection.execute(_query.query, [], function(err, result) {
                    if (err) {
                        console.log("#Error executing CREATE " + err.toString() + ".");
                        return cb(handleQueryError(err));
                    }
                    // Build model to return

                    var autoIncData = {};
                    if (autoIncPK) {
                        //récupération du dernier ID inséré
                        autoIncData[autoIncPK] = autoIncPKval;
                        var values = _.extend({}, _insertData, autoIncData);
                        cb(err, values);
                    }
                    else {
                        autoIncData[pk] = data[pk];
                        var values = _.extend({}, _insertData, autoIncData);
                        cb(err, values);
                    }

                });
            }
        },
        // Override of createEach to share a single connection
        // instead of using a separate connection for each request
        createEach: function(connectionName, collectionName, valuesList, cb, connection) {

            if (_.isUndefined(connection)) {
                return spawnConnection(__CREATE_EACH__, connections[connectionName], cb);
            } else {
                __CREATE_EACH__(connection, cb);
            }


            function __CREATE_EACH__(connection, cb) {

                var connectionObject = connections[connectionName];
                var collection = connectionObject.collections[collectionName];
                var tableName = collectionName;

                var records = [];

                async.eachSeries(valuesList, function(data, cb) {

                    // Prepare values

                    Object.keys(data).forEach(function(value) {
                        data[value] = utils.prepareValue(data[value]);
                    });

                    var attributes = collection.attributes;
                    var definition = collection.definition;
                    Object.keys(attributes).forEach(function(attributeName) {
                        var attribute = attributes[attributeName];
                        /* searching for column name, if it doesn't exist, we'll use attribute name */
                        var columnName = attribute.columnName || attributeName;
                        /* affecting values to add to the columns */
                        data[columnName] = data[attributeName];
                        /* deleting attributesto be added and their names are differnet from columns names */
                        if (attributeName !== columnName)
                            delete data[attributeName];
                        /* deleting not mapped attributes */
                        if ((_.isUndefined(definition[columnName])) || (_.isUndefined(data[columnName])))
                            delete data[columnName];
                        if (fieldIsDatetime(attribute)) {
                            data[columnName] = (!data[columnName]) ? 'null' : SqlString.dateField(data[columnName]);
                        }
                    });

                    var schema = collection.waterline.schema;
                    var _query;

                    var sequel = new Sequel(schema, sqlOptions);

                    // Build a query for the specific query strategy
                    try {
                        _query = sequel.create(collectionName, data);
                    } catch (e) {
                        return cb(e);
                    }

                    // Run query
                    console.log('Executing CE : ' + _query.query);
                    connection.execute(_query.query, [], function(err, results) {
                        if (err) {
                            console.log("#Error executing Create (CreateEach) " + err.toString() + ".");
                            return cb(handleQueryError(err));
                        }
                        records.push(results.insertId);
                        cb();
                    });
                }, function(err) {
                    if (err)
                        return cb(err);

                    var pk = 'id';

                    Object.keys(collection.definition).forEach(function(key) {
                        if (!collection.definition[key].hasOwnProperty('primaryKey'))
                            return;
                        pk = key;
                    });

                    // If there are no records (`!records.length`)
                    // then skip the query altogether- we don't need to look anything up
                    if (!records.length) {
                        return cb(null, []);
                    }

                    // Build a Query to get newly inserted records
                    /*  var query = 'SELECT * FROM ' + tableName.toUpperCase() + ' WHERE ' + pk + ' IN (' + records + ');';

                     // Run Query returing results
                     console.log('CEach2');
                     console.log(query);
                     connection.execute(query, [], function(err, results) {
                     if (err)
                     return cb(err);
                     cb(null, results);
                     });*/
                    cb(null, null);
                });

            }
        }
        ,
        // REQUIRED method if users expect to call Model.find(), Model.findAll() or related methods
        // You're actually supporting find(), findAll(), and other methods here
        // but the core will take care of supporting all the different usages.
        // (e.g. if this is a find(), not a findAll(), it will only close back a single model)
        find: function(connectionName, collectionName, options, cb, connection) {
            if (_.isUndefined(connection)) {
                return spawnConnection(__FIND__, connections[connectionName], cb);
            } else {
                __FIND__(connection, cb);
            }

            function __FIND__(connection, cb) {

                // Check if this is an aggregate query and that there is something to return
                if (options.groupBy || options.sum || options.average || options.min || options.max) {
                    if (!options.sum && !options.average && !options.min && !options.max) {
                        return cb(Errors.InvalidGroupBy);
                    }
                }

                var connectionObject = connections[connectionName];
                var collection = connectionObject.collections[collectionName];

                // Build find query
                var schema = collection.waterline.schema;
                var processor = new Processor();
                var _query;
                var sequel = new Sequel(schema, sqlOptions);

                //set default order by Primary key autoIncrement
                if (!options.groupBy) {
                    var PK = _getPK(connectionName, collectionName);
                    if (!options.sort) {
                        options.sort = {};
                    }
                    options.sort[PK] = 1;
                }


 		var limit = options.limit || null;
                var skip = options.skip || null;
                delete options.skip;
                delete options.limit;

                // Build a query for the specific query strategy
                try {
                    _query = sequel.find(collectionName, options);
                } catch (e) {
                    return cb(e);
                }

		var findQuery = _query.query[0];

                if (limit && skip) {
                    findQuery = 'SELECT * FROM (' + findQuery + ') WHERE LINE_NUMBER > ' + skip + ' and LINE_NUMBER <= ' + (skip + limit);
                }
                else if (limit) {
                    findQuery = 'SELECT * FROM (' + findQuery + ') WHERE LINE_NUMBER <= ' + limit;
                }
                else if (skip) {
                    findQuery = 'SELECT * FROM (' + findQuery + ') WHERE LINE_NUMBER > ' + skip;
                }


                // Run query
                if (LOG_QUERIES) {
                    console.log('\nExecuting ORACLE query: ', query);
                }
                console.log('Executing : ' + _query.query[0]);
                connection.execute(findQuery, [], function(err, result) {
                    if (err) {
                        console.log('#Error executing Find ' + err.toString() + '.');
                        return cb(err);
                    }


                    result = processor.synchronizeResultWithModel(result, collection.attributes);

                    cb(null, result);
                });

            }
        },
        // REQUIRED method if users expect to call Model.update()
        update: function(connectionName, collectionName, options, values, cb, connection) {
            if (_.isUndefined(connection)) {
                return spawnConnection(__UPDATE__, connections[connectionName], cb);
            } else {
                __UPDATE__(connection, cb);
            }

            function __UPDATE__(connection, cb) {
                var processor = new Processor();
                var connectionObject = connections[connectionName];
                var collection = connectionObject.collections[collectionName];

                // Build find query
                var schema = collection.waterline.schema;
                var _query;
                var sequel = new Sequel(schema, sqlOptions);

                // Build a query for the specific query strategy
                try {
                    //_query = sequel.find(collectionName, lodash.cloneDeep(options));
                    _query = sequel.find(collectionName, _.clone(options));
                } catch (e) {
                    return cb(e);
                }

                connection.execute(_query.query[0], [], function(err, results) {
                    if (err) {
                        console.log("#Error executing Find_1 (Update) " + err.toString() + ".");
                        return cb(err);
                    }
                    var ids = [];

                    var pk = 'id';
                    Object.keys(collection.definition).forEach(function(key) {
                        if (!collection.definition[key].hasOwnProperty('primaryKey'))
                            return;
                        pk = key;
                    });
                    // update statement will affect 0 rows
                    if (results.length === 0) {
                        return cb(null, []);
                    }

                    results.forEach(function(result) {
                        //ids.push(result[pk.toUpperCase()]);
                        ids.push(result[pk]);
                    });

                    // Prepare values
                    Object.keys(values).forEach(function(value) {
                        values[value] = utils.prepareValue(values[value]);
                    });

                    var definition = collection.definition;
                    var attrs = collection.attributes;

                    Object.keys(definition).forEach(function(columnName) {
                        var column = definition[columnName];

                        if (fieldIsDatetime(column)) {
                            if (!values[columnName])
                                return;
                            values[columnName] = SqlString.dateField(values[columnName]);
                        }
                        else if (fieldIsBoolean(column)) {
                            values[columnName] = (values[columnName]) ? 1 : 0;
                            console.log(columnName + " = " + values[columnName]);
                        }
                    });
                    // Build query
                    try {
                        _query = sequel.update(collectionName, options, values);
                    } catch (e) {
                        return cb(e);
                    }
                    console.log('Executing : ' + _query.query);
                    // Run query
                    connection.execute(_query.query, [], function(err, result) {
                        if (err) {
                            console.log('#Error executing Update ' + err.toString() + '.');
                            return cb(handleQueryError(err));
                        }

                        var criteria = {where: {}};

                        if (ids.length === 1) {
                            criteria.where[pk] = ids[0];
                        } else {
                            criteria.where[pk] = ids;
                        }

                        // Build a query for the specific query strategy
                        try {
                            _query = sequel.find(collectionName, criteria);
                        } catch (e) {
                            return cb(e);
                        }

                        var findQuery =  _query.query[0];

                        if(ids.length === 1){
                            findQuery = 'SELECT * FROM (' + findQuery + ') WHERE LINE_NUMBER = 1';
                        }

                        // Run query
                        connection.execute(findQuery, [], function(err, result) {
                            if (err) {
                                console.log("#Error executing Find_2 (Update) " + err.toString() + ".");
                                return cb(err);
                            }

                            result = processor.synchronizeResultWithModel(result, attrs);
                            cb(null, result);
                        });
                    });

                });
            }
        },
        // REQUIRED method if users expect to call Model.destroy()
        destroy: function(connectionName, collectionName, options, cb, connection) {


            if (_.isUndefined(connection)) {
                return spawnConnection(__DESTROY__, connections[connectionName], cb);
            } else {
                __DESTROY__(connection, cb);
            }

            function __DESTROY__(connection, cb) {

                var connectionObject = connections[connectionName];
                var collection = connectionObject.collections[collectionName];
                var tableName = collectionName;

                // Build query
                var schema = collection.waterline.schema;
                var _query;
                var sequel = new Sequel(schema, sqlOptions);

                // Build a query for the specific query strategy
                try {
                    _query = sequel.destroy(collectionName, options);
                } catch (e) {
                    return cb(e);
                }

                async.auto({
                    findRecords: function(next) {
                        adapter.find(connectionName, collectionName, options, next, connection);
                    },
                    destroyRecords: ['findRecords', function(next) {
                            console.log("Executing : " + _query.query);
                            connection.execute(_query.query, [], next);
                        }]
                },
                function(err, results) {
                    if (err)
                        return cb(err);

                    cb(null, results.findRecords);
                });

            }
        },
        // REQUIRED method if users expect to call Model.stream()
        stream: function(connectionName, collectionName, options, stream, connection) {
            console.log('stream');
            if (_.isUndefined(connection)) {
                return spawnConnection(__STREAM__, connections[connectionName]);
            } else {
                __STREAM__(connection);
            }

            function __STREAM__(connection, cb) {

                var connectionObject = connections[connectionName];
                var collection = connectionObject.collections[collectionName];
                var tableName = collectionName;

                // Build find query
                var query = sql.selectQuery(tableName, options);

                // Run query
                var dbStream = connection.execute(query);

                // Handle error, an 'end' event will be emitted after this as well
                dbStream.on('error', function(err) {
                    stream.end(err); // End stream
                    cb(err); // Close connection
                });

                // the field packets for the rows to follow
                dbStream.on('fields', function(fields) {
                });

                // Pausing the connnection is useful if your processing involves I/O
                dbStream.on('result', function(row) {
                    connection.pause();
                    stream.write(row, function() {
                        connection.resume();
                    });
                });

                // all rows have been received
                dbStream.on('end', function() {
                    stream.end(); // End stream
                    cb(); // Close connection
                });
            }
        },
        addAttribute: function(connectionName, collectionName, attrName, attrDef, cb, connection) {
            console.log('addAttribute');
            if (_.isUndefined(connection)) {
                return spawnConnection(__ADD_ATTRIBUTE__, connections[connectionName], cb);
            } else {
                __ADD_ATTRIBUTE__(connection, cb);
            }

            function __ADD_ATTRIBUTE__(connection, cb) {

                var connectionObject = connections[connectionName];
                var collection = connectionObject.collections[collectionName];
                var tableName = collectionName;

                var query = sql.addColumn(tableName, attrName, attrDef);

                // Run query
                /* if (LOG_QUERIES) {
                 console.log('\nExecuting MySQL query: ', query);
                 }*/

                // Run query
                connection.query(query, function(err, result) {
                    if (err)
                        return cb(err);

                    // TODO: marshal response to waterline interface
                    cb(err);
                });

            }
        },
        removeAttribute: function(connectionName, collectionName, attrName, cb, connection) {
            console.log('removeAttribute');
            if (_.isUndefined(connection)) {
                //LOOK LIKE MALFORMED
                return spawnConnection(connectionName, __REMOVE_ATTRIBUTE__, cb);
            } else {
                __REMOVE_ATTRIBUTE__(connection, cb);
            }

            function __REMOVE_ATTRIBUTE__(connection, cb) {

                var connectionObject = connections[connectionName];
                var collection = connectionObject.collections[collectionName];
                var tableName = collectionName;

                var query = sql.removeColumn(tableName, attrName);

                /*if (LOG_QUERIES) {
                 console.log('\nExecuting MySQL query: ', query);
                 }*/

                // Run query
                connection.query(query, function(err, result) {
                    if (err)
                        return cb(err);

                    // TODO: marshal response to waterline interface
                    cb(err);
                });

            }
        },
        count: function(connectionName, collectionName, options, cb, connection) {
            console.log('count');
            if (_.isUndefined(connection)) {
                return spawnConnection(__COUNT__, connections[connectionName], cb);
            } else {
                __COUNT__(connection, cb);
            }

            function __COUNT__(connection, cb) {

                // Check if this is an aggregate query and that there is something to return
                if (options.groupBy || options.sum || options.average || options.min || options.max) {
                    if (!options.sum && !options.average && !options.min && !options.max) {
                        return cb('InvalidGroupBy');
                    }
                }

                var connectionObject = connections[connectionName];
                var collection = connectionObject.collections[collectionName];
                var tableName = collectionName;

                // Build a copy of the schema to send w/ the query
                var localSchema = _.reduce(connectionObject.collections, function(localSchema, collection, cid) {
                    localSchema[cid] = collection.schema;
                    return localSchema;
                }, {});

                // Build find query
                var query = sql.countQuery(tableName, options, localSchema);

                // Run query
                console.log('Count *');
                console.log(query);
                connection.execute(query, [], function(err, result) {
                    if (err) {
                        console.log('#Error counting table \'' + collectionName + '\' rows (Count) ' + err.toString() + '.');
                        return cb(err);
                    }
                    // Return the count from the simplified query
                    cb(null, result[0].COUNT);
                });
            }
        },
        join: function(connectionName, collectionName, options, cb, connection) {
            console.log('Joining \'' + collectionName + '\' ...');
            if (_.isUndefined(connection)) {
                return spawnConnection(__JOIN__, connections[connectionName], cb);
            } else {
                __JOIN__(connection, cb);
            }

            function __JOIN__(client, done) {

                // Populate associated records for each parent result
                // (or do them all at once as an optimization, if possible)
                Cursor({
                    instructions: options,
                    nativeJoins: true,
                    /**
                     * Find some records directly (using only this adapter)
                     * from the specified collection.
                     *
                     * @param  {String}   collectionName
                     * @param  {Object}   criteria
                     * @param  {Function} _cb
                     */
                    $find: function(collectionName, criteria, _cb) {
                        return adapter.find(connectionName, collectionName, criteria, _cb, client);
                    },
                    /**
                     * Look up the name of the primary key field
                     * for the collection with the specified identity.
                     *
                     * @param  {String}   collectionName
                     * @return {String}
                     */
                    $getPK: function(collectionName) {
                        if (!collectionName)
                            return;
                        return _getPK(connectionName, collectionName);
                    },
                    /**
                     * Given a strategy type, build up and execute a SQL query for it.
                     *
                     * @param {}
                     */

                    $populateBuffers: function populateBuffers(options, next) {

                        var buffers = options.buffers;
                        var instructions = options.instructions;

                        // Grab the collection by looking into the connection
                        var connectionObject = connections[connectionName];
                        var collection = connectionObject.collections[collectionName];

                        var parentRecords = [];
                        var cachedChildren = {};

                        // Grab Connection Schema
                        var schema = {};

                        Object.keys(connectionObject.collections).forEach(function(coll) {
                            schema[coll] = connectionObject.collections[coll].schema;
                        });
                        var processor = new Processor();
                        // Build Query
                        var _schema = collection.waterline.schema;

                        var sequel = new Sequel(_schema, sqlOptions);
                        var _query;

                        // Build a query for the specific query strategy
                        try {

                            _query = sequel.find(collectionName, instructions);
                            console.log("_query:");
                            console.log(_query);
                        } catch (e) {
                            return next(e);
                        }

                        async.auto({
                            processParent: function(next) {
                                console.log("processParent find:");
                                adapter.find(connectionName, collectionName, instructions, function __FIND__(err, result) {
                                //client.execute(_query.query[0], [], function __FIND__(err, result) {
                                    if (err) {
                                        console.log('#Error fetching parent \'' + collectionName + '\' rows (Join) ' + err.toString() + '.');
                                        return next(err);
                                    }
                                    var attrs = collection.attributes;
                                    //result = processor.synchronizeResultWithModel(result, attrs);

                                    parentRecords = result;

                                    var splitChildren = function(parent, next) {
                                        var cache = {};

                                        _.keys(parent).forEach(function(key) {
                                            console.log(key);
                                            // Check if we can split this on our special alias identifier '___' and if
                                            // so put the result in the cache
                                            var split = key.split('___');
                                            if (split.length < 2)
                                                return;

                                            if (!hop(cache, split[0]))
                                                cache[split[0]] = {};
                                            cache[split[0]][split[1]] = parent[key];
                                            delete parent[key];
                                        });

                                        // Combine the local cache into the cachedChildren
                                        if (_.keys(cache).length > 0) {
                                            _.keys(cache).forEach(function(pop) {
                                                if (!hop(cachedChildren, pop))
                                                    cachedChildren[pop] = [];
                                                cachedChildren[pop] = cachedChildren[pop].concat(cache[pop]);
                                            });
                                        }

                                        next();
                                    };


                                    // Pull out any aliased child records that have come from a hasFK association
                                    async.eachSeries(parentRecords, splitChildren, function(err) {
                                        if (err)
                                            return next(err);
                                        buffers.parents = parentRecords;
                                        next();
                                    });
                                },client);
                            },
                            // Build child buffers.
                            // For each instruction, loop through the parent records and build up a
                            // buffer for the record.
                            buildChildBuffers: ['processParent', function(next, results) {
                                    console.log('buildChildBuffers:');
                                    async.each(_.keys(instructions.instructions), function(population, nextPop) {
                                        var populationObject = instructions.instructions[population];
                                        //console.log('-' + population, populationObject);
                                        var popInstructions = populationObject.instructions;
                                        //var pk = _getPK(connectionName, popInstructions[0].parent).toUpperCase();
                                        var pk = _getPK(connectionName, popInstructions[0].parent);
                                        //var modelPk = _getModelPK(connectionName, popInstructions[0].parent, pk);
                                        //console.log('pk :' , pk , 'modelPk ', modelPk)  ;

                                        var alias = populationObject.strategy.strategy === 1 ? popInstructions[0].parentKey : popInstructions[0].alias;
                                        //console.log('Alias ---->----->--->-->-->->->>', alias);
                                        // Use eachSeries here to keep ordering
                                        async.eachSeries(parentRecords, function(parent, nextParent) {
                                            var buffer = {
                                                attrName: population,
                                                //parentPK: /*parent[pk],*/parent[modelPk],
                                                //pkAttr: /*pk,*/ modelPk,
                                                parentPK: parent[pk],
                                                pkAttr: pk,
                                                keyName: alias
                                            };

                                            var records = [];
                                            //console.log('cached children', cachedChildren);
                                            // Check for any cached parent records
                                            console.log(cachedChildren,alias);
                                            if (hop(cachedChildren, alias)) {

                                                cachedChildren[alias].forEach(function(cachedChild) {
                                                    var childVal = popInstructions[0].childKey;
                                                    var parentVal = popInstructions[0].parentKey;
                                                    //console.log(childVal+' must be equal to '+parentVal);
                                                    if (cachedChild[childVal] !== parent[parentVal]) {
                                                        return;
                                                    }

                                                    // If null value for the parentVal, ignore it
                                                    if (parent[parentVal] === null)
                                                        return;

                                                    records.push(cachedChild);
                                                    //console.log('cached child',popInstructions[0]);
                                                });
                                            }
                                            //console.log('records', records);
                                            var childCollection = popInstructions[0].child;
                                            var attrs = connections[connectionName].collections[childCollection].attributes;
                                            records = processor.synchronizeResultWithModel(records, attrs);

                                            if (records.length > 0) {
                                                buffer.records = records;
                                            }

                                            buffers.add(buffer);
                                            nextParent();
                                        }, nextPop);
                                    }, next);
                                }],
                            processChildren: ['buildChildBuffers', function(next, results) {

                                    // Remove the parent query
                                    _query.query.shift();
                                    console.log("_query.query.shift()");
                                    console.log(_query);

                                    //console.log('_query.query', _query.query);
                                    async.each(_query.query, function(q, next) {
                                        console.log("makng union");
                                        var childCollection = q.instructions.child;
                                        var qs = '';
                                        var pk;
                                        var modelPk;
                                        if (!Array.isArray(q.instructions)) {
                                            pk = _getPK(connectionName, q.instructions.parent);
                                            modelPk = _getModelPK(connectionName, q.instructions.parent, pk);
                                        }
                                        else if (q.instructions.length > 1) {
                                            pk = _getPK(connectionName, q.instructions[0].parent);
                                            modelPk = _getModelPK(connectionName, q.instructions[0].parent, pk);
                                        }
                                        //console.log('PK', pk);
                                        //console.log('ParentsRecord', parentRecords);
                                        var i = 0;
                                        parentRecords.forEach(function(parent) {
                                            if (_.isNumber(parent[modelPk])) {
                                                //qs += q.qs.replace('^?^', parent[pk]).slice(0,-32) + ' UNION ';
                                                //var queryI = q.qs.replace('^?^', parent[pk]).slice(0, -32);
                                                var queryI = q.qs.replace('^?^', parent[modelPk])/*.slice(0, -32)*/;
                                                //queryI = queryI.substring(0,queryI.length-32);
                                                //queryI = queryI.split('ORDER BY')[0];// pour supprimer la clause order by
                                                if (i !== 0)
                                                    queryI = '( ' + queryI + ' ) UNION ';
                                                else
                                                    queryI += ' UNION ';
                                                qs += queryI;
                                            } else {
                                                //var queryI = q.qs.replace('^?^', '"' + parent[pk] + '"').slice(0, -32);
                                                var queryI = q.qs.replace('^?^', '"' + parent[modelPk] + '"')/*.slice(0, -32)*/;
                                                //queryI = queryI.substring(0,queryI.length-32);
                                                queryI = queryI.split('ORDER BY')[0];
                                                if (i !== 0)
                                                    queryI = '( ' + queryI + ' ) UNION ';
                                                else
                                                    queryI += ' UNION ';
                                                qs += queryI;
                                            }
                                            i++;
                                        });

                                        // Remove the last UNION
                                        qs = qs.slice(0, -7);

                                        // Add a final sort to the Union clause for integration
                                        /*if (parentRecords.length > 1) {
                                         qs += ' ORDER BY ';

                                         if (!Array.isArray(q.instructions)) {
                                         lodash.keys(q.instructions.criteria.sort).forEach(function(sortKey) {
                                         var direction = q.instructions.criteria.sort[sortKey] === 1 ? 'ASC' : 'DESC';
                                         qs += sortKey + ' ' + direction;
                                         });
                                         }
                                         else if (q.instructions.length === 2) {
                                         lodash.keys(q.instructions[1].criteria.sort).forEach(function(sortKey) {
                                         var direction = q.instructions[1].criteria.sort[sortKey] === 1 ? 'ASC' : 'DESC';
                                         qs += sortKey + ' ' + direction;
                                         });
                                         }
                                         }*/
                                        console.log('Executing : ', qs);
                                        client.execute(qs, [], function __FIND__(err, result) {
                                            if (err) {
                                                console.log("#Error populating '" + childCollection + "' collection in '" + collectionName + "' (Join) " + err.toString() + ".");
                                                return next(err);
                                            }
                                            var groupedRecords = {};
                                            //console.log('Result : ',result);
                                            result.forEach(function(row) {

                                                if (!Array.isArray(q.instructions)) {
                                                    if (!hop(groupedRecords, row[q.instructions.childKey])) {
                                                        groupedRecords[row[q.instructions.childKey]] = [];
                                                    }
                                                    //console.log('row',row,'ch',q.instructions.childKey);
                                                    groupedRecords[row[q.instructions.childKey]].push(row);
                                                }
                                                else {

                                                    // Grab the special "foreign key" we attach and make sure to remove it
                                                    var fk = '___' + q.instructions[0].childKey;

                                                    if (!hop(groupedRecords, row[fk])) {
                                                        groupedRecords[row[fk]] = [];
                                                    }

                                                    var data = _.cloneDeep(row);
                                                    delete data[fk];
                                                    groupedRecords[row[fk]].push(data);
                                                }
                                            });
                                            //console.log('grouppedRecords', groupedRecords);
                                            buffers.store.forEach(function(buffer) {

                                                if (buffer.attrName !== q.attrName)
                                                    return;
                                                var records = groupedRecords[buffer.belongsToPKValue];

                                                if (!records)
                                                    return;
                                                if (!buffer.records)
                                                    buffer.records = [];
                                                //console.log('parent and child ', parentCollection, childCollection);
                                                var attrs = connections[connectionName].collections[childCollection].attributes;
                                                records = processor.synchronizeResultWithModel(records, attrs);
                                                buffer.records = buffer.records.concat(records);
                                            });
                                            //console.log('*-*', buffers);

                                            next();
                                        });
                                    }, function(err) {
                                        next();
                                    });

                                }]

                        },
                        function(err) {
                            if (err)
                                return next(err);
                            next();
                        });

                    }

                }, done);
            }
        }
        /*
         **********************************************
         * Optional overrides
         **********************************************

         // Optional override of built-in batch create logic for increased efficiency
         // otherwise, uses create()
         createEach: function (collectionName, cb) { cb(); },

         // Optional override of built-in findOrCreate logic for increased efficiency
         // otherwise, uses find() and create()
         findOrCreate: function (collectionName, cb) { cb(); },

         // Optional override of built-in batch findOrCreate logic for increased efficiency
         // otherwise, uses findOrCreate()
         findOrCreateEach: function (collectionName, cb) { cb(); }
         */


        /*
         **********************************************
         * Custom methods
         **********************************************

         ////////////////////////////////////////////////////////////////////////////////////////////////////
         //
         // > NOTE:  There are a few gotchas here you should be aware of.
         //
         //    + The collectionName argument is always closeed as the first argument.
         //      This is so you can know which model is requesting the adapter.
         //
         //    + All adapter functions are asynchronous, even the completely custom ones,
         //      and they must always include a callback as the final argument.
         //      The first argument of callbacks is always an error object.
         //      For some core methods, Sails.js will add support for .done()/promise usage.
         //
         //    +
         //
         ////////////////////////////////////////////////////////////////////////////////////////////////////


         // Any other methods you include will be available on your models
         foo: function (collectionName, cb) {
         cb(null,"ok");
         },
         bar: function (collectionName, baz, watson, cb) {
         cb("Failure!");
         }


         // Example success usage:

         Model.foo(function (err, result) {
         if (err) console.error(err);
         else console.log(result);

         // outputs: ok
         })

         // Example error usage:

         Model.bar(235, {test: 'yes'}, function (err, result){
         if (err) console.error(err);
         else console.log(result);

         // outputs: Failure!
         })

         */


    };

    return adapter;


    //////////////                 //////////////////////////////////////////
    ////////////// Private Methods //////////////////////////////////////////
    //////////////                 //////////////////////////////////////////

    function _getPK(connectionIdentity, collectionIdentity) {
        var collectionDefinition;
        try {
            collectionDefinition = connections[connectionIdentity].collections[collectionIdentity].definition;

            //return lodash.find(Object.keys(collectionDefinition), function _findPK(key) {
            return _.find(Object.keys(collectionDefinition), function _findPK(key) {
                var attrDef = collectionDefinition[key];
                if (attrDef && attrDef.primaryKey)
                    return key;
                else
                    return false;
            }) || 'id';
        }
        catch (e) {
            throw new Error('Unable to determine primary key for collection `' + collectionIdentity + '` because ' +
                    'an error was encountered acquiring the collection definition:\n' + require('util').inspect(e, false, null));
        }
    }
    function _getModelPK(connectionIdentity, collectionIdentity, pk) {

        var attributes;
        try {
            attributes = connections[connectionIdentity].collections[collectionIdentity].attributes;
            var modelPk;
            Object.keys(attributes).forEach(function(key) {
                var columnName = attributes[key].columnName || key;
                if (columnName === pk) {
                //if (columnName.toUpperCase() === pk) {
                    modelPk = key;
                }
                return;
            });
            return modelPk;
        }
        catch (e) {
            throw new Error('Unable to determine model primary key for collection `' + collectionIdentity + '` because ' +
                    'an error was encountered acquiring the collection definition:\n' + require('util').inspect(e, false, null));
        }
    }

    function _getColumnName(connectionIdentity, collectionIdentity, attr) {

        var attributes;
        try {
            attributes = connections[connectionIdentity].collections[collectionIdentity].attributes;
            var attribute = attributes[attr];
            if (attribute) {
                var columnName = attribute.columnName || attr;
                return columnName.upperCase();
            }
        }
        catch (e) {
            throw new Error('Unable to determine model primary key for collection `' + collectionIdentity + '` because ' +
                    'an error was encountered acquiring the collection definition:\n' + require('util').inspect(e, false, null));
        }
    }
    // Wrap a function in the logic necessary to provision a connection
    // (either grab a free connection from the pool or create a new one)
    // cb is optional (you might be streaming)
    function spawnConnection(logic, connection, cb) {
        var pool = connection.connection;
        pool.acquire(function(err, cnx) {
            logic(cnx, function(err, result) {
                if (err) {
                    cb(err, 1);
                    console.log("Logic error in Oracle ORM.");
                    console.log(err);
                    return pool.release(cnx);
                }
                pool.release(cnx);
                cb(err, result);
            });
        });
    }

    // Convert standard adapter config
    // into a custom configuration object for node-oracle
    function marshalConfig(config) {
        return {
            tns: config.tns,
            user: config.user,
            password: config.password
        };
    }

    function handleQueryError(err) {

        var formattedErr;

        // Check for uniqueness constraint violations:
        if (err.code === 'ER_DUP_ENTRY') {

            // Manually parse the MySQL error response and extract the relevant bits,
            // then build the formatted properties that will be passed directly to
            // WLValidationError in Waterline core.
            var matches = err.message.match(/Duplicate entry '(.*)' for key '(.*?)'$/);
            if (matches && matches.length) {
                formattedErr = {};
                formattedErr.code = 'E_UNIQUE';
                formattedErr.invalidAttributes = {};
                formattedErr.invalidAttributes[matches[2]] = [{
                        value: matches[1],
                        rule: 'unique'
                    }];
            }
        }

        return formattedErr || err;
    }

    //check if column or attribute is a boolean
    function fieldIsBoolean(column) {
        return (!_.isUndefined(column.type) && column.type === 'boolean');
    }

    function fieldIsDatetime(column) {
        return (!_.isUndefined(column.type) && column.type === 'datetime');
    }

    function fieldIsAutoIncrement(column) {
        return (!_.isUndefined(column.autoIncrement) && column.autoIncrement);
    }

})();

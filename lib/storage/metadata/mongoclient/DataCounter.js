const NEW_OBJ = 0;
const NEW_VER = 1;
const UPDATE_VER = 2;
const UPDATE_MST = 3;
const RESTORE = 4;

const DEL_VER = 0;
const DEL_MST = 1;

const CURR = 'curr';
const PREV = 'prev';

function deepCopyObject(obj) {
    return JSON.parse(JSON.stringify(obj));
}

class DataCounter {
    /**
     * DataCounter - class for keeping track of the ItemCount metrics
     * @return {DataCounter} DataCounter object
     */
    constructor() {
        this.objects = 0;
        this.versions = 0;
        this.dataManaged = {
            total: { curr: 0, prev: 0 },
            byLocation: {},
        };
        this.stalled = 0;
        this.populated = false;
        this.transientList = {};
    }

    /**
     * updateTransientList - update data counter list of transient locations
     * @param  {Object} newLocations - list of locations constraint details
     * @return {undefined}
     */
    updateTransientList(newLocations) {
        if (newLocations && Object.keys(newLocations).length > 0) {
            const tempList = {};
            Object.keys(newLocations).forEach(loc => {
                tempList[loc] = newLocations[loc].isTransient;
            });
            this.transientList = tempList;
        }
    }

    /**
     * set - set DataCounter values
     * @param {Object} setVal - object containing values to be used for setting
     * DataCounter
     * @param {number} setVal.objects - number of master objects
     * @param {number} setVal.versions - number of versioned objects
     * @param {Object} setVal.dataManaged - object containing information about
     * all the data managed
     * @param {Object} setVal.total - object containing the total byte count of
     * data managed
     * @param {number} setVal.total.curr - the total byte count of master
     * objects
     * @param {number} setVal.total.prev - the total byte count of versioned
     * objects
     * @param {Object} setVal.byLocaton - object containing the information
     * about data managed on each location
     * @return {undefined}
     */
    set(setVal) {
        if (setVal) {
            this.objects = setVal.objects;
            this.versions = setVal.versions;
            this.dataManaged = deepCopyObject(setVal.dataManaged);
            this.populated = true;
            this.stalled = setVal.stalled;
        }
    }

    /**
     * results - creates a deep copy of the current DataCounter values
     * @return {Object} - object containing the current DataCounter values
     */
    results() {
        const obj = {
            objects: this.objects,
            versions: this.versions,
            dataManaged: this.dataManaged,
            stalled: this.stalled,
        };
        return deepCopyObject(obj);
    }

    /**
     * addObjectFn - performing add operations
     * @param {ObjectMD} currMD - new master version metadata
     * @param {ObjectMD} prevMD - old master version metadata
     * @param {number} type - index of the current type of add operation
     * @return {undefined}
     */
    addObject(currMD, prevMD, type) {
        if (type !== undefined && type !== null && this.populated) {
            switch (type) {
            case NEW_OBJ: // add new object, replace master if needed
                if (prevMD) {
                    this._delValue(prevMD, CURR);
                    this._addValue(currMD, CURR);
                } else {
                    ++this.objects;
                    this._addValue(currMD, CURR);
                }
                break;
            case NEW_VER: // add new object, archive master
                ++this.versions;
                this._delValue(prevMD, CURR);
                this._addValue(prevMD, PREV);
                this._addValue(currMD, CURR);
                break;
            case UPDATE_VER: // update archived object, replication info
                this._updateObject(currMD, prevMD, PREV);
                break;
            case UPDATE_MST: // update master object, replication info
                this._updateObject(currMD, prevMD, CURR);
                break;
            case RESTORE:
                --this.versions;
                this._delValue(currMD, PREV);
                ++this.objects;
                this._addValue(currMD, CURR);
                break;
            default:
                // should throw error, noop
                break;
            }
        }
    }

    /**
     * delObjectFn - performing del operations
     * @param {ObjectMD} currMD - object metadata
     * @param {number} type - index of the current type of delete operation
     * @return {undefined}
     */
    delObject(currMD, type) {
        if (type !== undefined && type !== null && this.populated) {
            switch (type) {
            case DEL_VER:
                --this.versions;
                this._delValue(currMD, PREV);
                break;
            case DEL_MST:
                --this.objects;
                this._delValue(currMD, CURR);
                break;
            default:
                // should throw error, noop
                break;
            }
        }
    }

    _addLocation(site, size, type) {
        this.dataManaged.total[type] += size;
        if (!this.dataManaged.byLocation[site]) {
            this.dataManaged.byLocation[site] = {
                curr: 0,
                prev: 0,
            };
        }
        this.dataManaged.byLocation[site][type] += size;
    }

    /**
     * _addValue - helper function for handling put object updates
     * @param {ObjectMD} objMD - object metadata
     * @param {string} type - string with value either 'curr' or 'prev'
     * @return {undefined}
     */
    _addValue(objMD, type) {
        if (objMD) {
            const { replicationInfo, 'content-length': size } = objMD;
            const { backends } = replicationInfo || {};
            this._addLocation(objMD.dataStoreName, size, type);
            if (backends && Array.isArray(backends)) {
                backends.forEach(loc => {
                    const { site, status } = loc;
                    if (status === 'COMPLETED') {
                        this._addLocation(site, size, type);
                    }
                });
            }
        }
    }

    /**
     * _updateObject - helper function for handling updates from replication
     * info changes
     * @param {ObjectMD} currMD - new object metadata
     * @param {ObjectMD} prevMD - old object metadata
     * @param {string} type - string with value either 'curr' or 'prev'
     * @return {undefined}
     */
    _updateObject(currMD, prevMD, type) {
        const transientList = Object.assign({}, this.transientList);
        if (currMD && prevMD) {
            // check for changes in replication
            const { replicationInfo: currLocs,
                'content-length': size, dataStoreName } = currMD;
            const { replicationInfo: prevLocs } = prevMD;
            const { backends: prevBackends } = prevLocs || {};
            const { backends: currBackends } = currLocs || {};
            const oldLocs = {};
            if (prevBackends && Array.isArray(prevBackends)) {
                prevBackends.forEach(loc => {
                    const { site, status } = loc;
                    oldLocs[site] = status;
                });
            }
            if (currBackends && Array.isArray(currBackends)) {
                currBackends.forEach(loc => {
                    const { site, status } = loc;
                    if (site in oldLocs && status === 'COMPLETED' &&
                        oldLocs[site] !== status) {
                        this._addLocation(site, size, type);
                    }
                });
            }
            if (currLocs.status === 'COMPLETED' &&
                transientList[dataStoreName]) {
                this._delLocation(dataStoreName, size, type);
            }
        }
    }

    _delLocation(site, size, type) {
        if (this.dataManaged.byLocation[site]) {
            this.dataManaged.total[type] -= size;
            this.dataManaged.total[type] =
                Math.max(0, this.dataManaged.total[type]);
            this.dataManaged.byLocation[site][type] -= size;
            this.dataManaged.byLocation[site][type] =
                Math.max(0, this.dataManaged.byLocation[site][type]);
        }
    }
    /**
     * _delValue - helper function for handling delete object operations
     * @param {ObjectMD} objMD - object metadata
     * @param {string} type - string with value either 'curr' or 'prev'
     * @return {undefined}
     */
    _delValue(objMD, type) {
        if (objMD) {
            const { replicationInfo, 'content-length': size } = objMD;
            const { backends } = replicationInfo || {};
            this._delLocation(objMD.dataStoreName, size, type);
            if (backends && Array.isArray(backends)) {
                backends.forEach(loc => {
                    const { site, status } = loc;
                    if (status === 'COMPLETED') {
                        this._delLocation(site, size, type);
                    }
                });
            }
        }
    }
}

module.exports = {
    NEW_OBJ,
    NEW_VER,
    UPDATE_VER,
    UPDATE_MST,
    RESTORE,
    DEL_VER,
    DEL_MST,
    DataCounter,
};

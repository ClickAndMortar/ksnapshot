const axios = require('axios');
const qs = require('qs');

module.exports = {
    findSnapshotSchedules() {
        return axios.get(`/apis/ksnapshot.clickandmortar.io/v1alpha1/schedules`);
    },
    findCronJobs(labels) {
        return axios.get(`/apis/batch/v1beta1/cronjobs`, {params: {labelSelector: qs.stringify(labels, { encodeValuesOnly: true })}});
    },
    findJobs(labels) {
        return axios.get(`/apis/batch/v1beta1/jobs`, {params: {labelSelector: qs.stringify(labels, { encodeValuesOnly: true })}});
    },
    findCronJob(namespace, name) {
        return axios.get(`/apis/batch/v1beta1/namespaces/${namespace}/cronjobs/${name}`);
    },
    findJob(namespace, name) {
        return axios.get(`/apis/batch/v1beta1/namespaces/${namespace}/jobs/${name}`);
    },
    createCronJob(namespace, name, labels, spec) {
        const url = `/apis/batch/v1beta1/namespaces/${namespace}/cronjobs`;
        const data = {
            metadata: {
                name: name,
                labels: labels
            },
            spec: spec
        };

        return axios.post(
            url,
            data
        );
    },
    createOrUpdateJob(namespace, name, labels, spec) {
        const url = `/apis/batch/v1beta1/namespaces/${namespace}/jobs`;
        const data = {
            metadata: {
                name: name,
                labels: labels
            },
            spec: spec
        };

        return axios.post(
            url,
            data
        );
    }
};

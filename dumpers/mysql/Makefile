all: build push

default: build

build:
	docker build -t clickandmortar/k8s-mysql-dumper:8 -t clickandmortar/k8s-mysql-dumper:latest .

push:
	docker push clickandmortar/k8s-mysql-dumper:8
	docker push clickandmortar/k8s-mysql-dumper:latest

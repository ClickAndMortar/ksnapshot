all: build push

default: build

build:
	docker build -f Dockerfile-5.7 -t clickandmortar/ksnapshot-dumper:mysql-5.7 .
	docker build -f Dockerfile-8 -t clickandmortar/ksnapshot-dumper:mysql-8 .

push:
	docker push clickandmortar/ksnapshot-dumper:mysql-5.7
	docker push clickandmortar/ksnapshot-dumper:mysql-8

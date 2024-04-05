all: build push

default: build

build:
	docker build --platform linux/amd64 -f Dockerfile-8 -t clickandmortar/ksnapshot-dumper:mysql-8 .
#	docker build -f Dockerfile-5.7 -t clickandmortar/ksnapshot-dumper:mysql-5.7 .

push:
	docker push clickandmortar/ksnapshot-dumper:mysql-8
#	docker push clickandmortar/ksnapshot-dumper:mysql-5.7
